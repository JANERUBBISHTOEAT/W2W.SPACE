import { execFile } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startRedis } from "./helpers.mjs";

const execFileAsync = promisify(execFile);
const projectDirectory = fileURLToPath(new URL("..", import.meta.url));

test("token storage and expiration preserve existing shared records", { timeout: 60000 }, async (t) => {
  const redis = await startRedis();
  t.after(() => redis.stop());

  // Application modules create their own Redis clients at import time. Each
  // child receives this test's isolated Redis address before importing them,
  // then exits explicitly so those private clients cannot keep the suite alive.
  async function runCase(source) {
    const script = `
      import assert from 'node:assert/strict';
      import Redis from 'ioredis';
      import HashMap from './app/utils/hashmap.server.ts';
      const redis = new Redis({
        host: process.env.REDIS_HOST,
        port: Number(process.env.REDIS_PORT),
      });
      try {
        ${source}
        await redis.quit();
        process.exit(0);
      } catch (error) {
        console.error(error);
        redis.disconnect();
        process.exit(1);
      }
    `;
    try {
      await execFileAsync(process.execPath, ["--input-type=module", "-e", script], {
        cwd: projectDirectory,
        env: {
          ...process.env,
          NODE_ENV: "test",
          REDIS_HOST: redis.host,
          REDIS_PORT: String(redis.port),
        },
        timeout: 10000,
        maxBuffer: 1024 * 1024,
      });
    } catch (error) {
      throw new Error(`Storage regression failed:\n${error.stderr || error.message}`, { cause: error });
    }
  }

  await t.test("zero-padded token collisions keep both records accessible", async () => {
    await runCase(`
      // These IDs collide at the existing three-digit candidate, "027".
      const first = await HashMap.generateTextToken('token-regression-36');
      const second = await HashMap.generateTextToken('token-regression-160');
      assert.equal(first, '027');
      assert.notEqual(second, first);
      assert.equal(await HashMap.getText(first), 'token-regression-36');
      assert.equal(await HashMap.getText(second), 'token-regression-160');
    `);
  });

  await t.test("file and text allocations cannot replace each other's mappings", async () => {
    await runCase(`
      const textToken = await HashMap.generateTextToken('cross-type-record');
      const fileToken = await HashMap.genToken('cross-type-record');
      assert.notEqual(fileToken, textToken);
      assert.equal(await HashMap.getText(textToken), 'cross-type-record');
      assert.equal(await HashMap.getFile(fileToken), 'cross-type-record');
      assert.equal(await HashMap.getFile(textToken), null);
      assert.equal(await HashMap.getText(fileToken), null);
      await assert.rejects(HashMap.set(textToken, 'another-file'), /already belongs/);
      await assert.rejects(HashMap.setText(fileToken, 'another-text'), /already belongs/);
      assert.equal(await HashMap.getText(textToken), 'cross-type-record');
      assert.equal(await HashMap.getFile(fileToken), 'cross-type-record');
    `);
  });

  await t.test("concurrent allocations stay unique and repeated allocation is idempotent", async () => {
    await runCase(`
      // Both requests start with the exact same candidate. Check-and-set
      // allocation can return one token to both callers under this race.
      const [fileToken, textToken] = await Promise.all([
        HashMap.genToken('atomic-cross-type-record'),
        HashMap.generateTextToken('atomic-cross-type-record'),
      ]);
      assert.notEqual(fileToken, textToken);
      assert.equal(await HashMap.getFile(fileToken), 'atomic-cross-type-record');
      assert.equal(await HashMap.getText(textToken), 'atomic-cross-type-record');
      const records = Array.from({ length: 64 }, (_, index) => ({
        id: 'concurrent-record-' + index,
        type: index % 2 === 0 ? 'file' : 'text',
      }));
      const tokens = await Promise.all(records.map(({ id, type }) =>
        type === 'file' ? HashMap.genToken(id) : HashMap.generateTextToken(id)
      ));
      assert.equal(new Set(tokens).size, records.length);
      for (let index = 0; index < records.length; index++) {
        const mapping = await HashMap.getBoth(tokens[index]);
        assert.equal(mapping.type, records[index].type);
        assert.equal(mapping.fileId || mapping.textId, records[index].id);
      }
      const repeated = await Promise.all(Array.from({ length: 16 }, () =>
        HashMap.genToken('idempotent-file-record')
      ));
      assert.equal(new Set(repeated).size, 1);
      assert.equal(await HashMap.getFile(repeated[0]), 'idempotent-file-record');
    `);
  });

  await t.test("deleted tokens remain tombstones and do not resolve to live content", async () => {
    await runCase(`
      for (const type of ['file', 'text']) {
        const id = 'deleted-record-' + type;
        const allocate = () => type === 'file'
          ? HashMap.genToken(id)
          : HashMap.generateTextToken(id);
        const token = await allocate();
        await redis.hset('unifiedTokenMap', token, JSON.stringify({ type, id, status: 'deleted' }));
        assert.equal(await HashMap.get(token), null);
        assert.equal(await HashMap.getFile(token), null);
        assert.equal(await HashMap.getText(token), null);
        assert.equal((await HashMap.getBoth(token)).status, 'deleted');
        assert.notEqual(await allocate(), token);
        assert.equal((await HashMap.getBoth(token)).status, 'deleted');
      }
    `);
  });

  await t.test("exhaustion rejects allocation without overwriting occupied candidates", async () => {
    await runCase(`
      // Fixed candidates for this legacy-format ID cover every retry slot.
      const candidates = ['826', '1219', '79507', '672120', '0753921',
        '12062751', '193004022', '7088064366', '33409029859', '934544477749'];
      for (const token of candidates) {
        await redis.hsetnx('unifiedTokenMap', token,
          JSON.stringify({ type: 'text', id: 'occupied-' + token, status: 'OK' }));
      }
      const before = await redis.hmget('unifiedTokenMap', ...candidates);
      await assert.rejects(HashMap.genToken('exhaustion-record'), /unique sharing token/);
      assert.deepEqual(await redis.hmget('unifiedTokenMap', ...candidates), before);
    `);
  });

  await t.test("legacy magnet mappings continue to resolve", async () => {
    await runCase(`
      const magnet = 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567';
      await redis.hset('unifiedTokenMap', 'legacy-token', JSON.stringify({ type: 'file', magnet }));
      assert.equal(await HashMap.get('legacy-token'), magnet);
    `);
  });

  await t.test("expiration removes old texts while preserving long live tokens and unrelated mappings", async () => {
    await runCase(`
      const { cleanupExpiredRecords } = await import('./app/utils/cleanup.server.ts');
      const now = new Date().toISOString();
      const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
      const key = 'user:expiration-test:texts';
      const records = [
        { id: 'live-text', token: '983001', lastEditedAt: now },
        { id: 'expired-text', token: '983002', lastEditedAt: old },
        { id: 'stale-collision', token: '983001', lastEditedAt: old },
        { id: 'recently-edited', token: '983003', lastEditedAt: now, lastAccessedAt: old },
        { id: 'stale-file-collision', token: '983004', lastEditedAt: old },
      ];
      for (const record of records) await redis.hset(key, record.id, JSON.stringify(record));
      for (const [token, type, id] of [
        ['983001', 'text', 'live-text'],
        ['983002', 'text', 'expired-text'],
        ['983003', 'text', 'recently-edited'],
        ['983004', 'file', 'unrelated-file'],
      ]) await redis.hset('unifiedTokenMap', token, JSON.stringify({ type, id, status: 'OK' }));
      await cleanupExpiredRecords();
      await cleanupExpiredRecords();
      assert.deepEqual((await redis.hkeys(key)).sort(), ['live-text', 'recently-edited']);
      assert.equal((await HashMap.getBoth('983001')).status, 'OK');
      assert.equal((await HashMap.getBoth('983002')).status, 'deleted');
      assert.equal((await HashMap.getBoth('983003')).status, 'OK');
      assert.equal((await HashMap.getBoth('983004')).status, 'OK');
    `);
  });
});
