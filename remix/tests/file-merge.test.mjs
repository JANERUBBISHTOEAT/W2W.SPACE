import { execFile } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { startRedis } from "./helpers.mjs";

const execFileAsync = promisify(execFile);
const projectDirectory = fileURLToPath(new URL("..", import.meta.url));

test("login migration preserves existing file sharing", { timeout: 60000 }, async (t) => {
  const redis = await startRedis();
  t.after(() => redis.stop());
  // Bundle the TypeScript utility with its relative imports while leaving the
  // real Redis/package boundaries intact. Every child uses disposable Redis.
  const { outputFiles } = await build({
    entryPoints: ["app/utils/data.server.ts"],
    absWorkingDir: projectDirectory,
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    packages: "external",
  });

  async function runCase(source) {
    const script = `
      const utilities = (() => {
        const module = { exports: {} };
        ${outputFiles[0].text}
        return module.exports;
      })();
      const assert = require('node:assert/strict');
      const Redis = require('ioredis');
      const redis = new Redis({ host: process.env.REDIS_HOST, port: Number(process.env.REDIS_PORT) });
      const { createEmptyFile, updateFile, mergeFiles, getFiles, getFileByToken, deleteFile } = utilities;
      (async () => {
        try {
          ${source}
          await redis.quit();
          process.exit(0);
        } catch (error) {
          console.error(error);
          redis.disconnect();
          process.exit(1);
        }
      })();
    `;
    try {
      await execFileAsync(process.execPath, ["--input-type=commonjs", "-e", script], {
        cwd: projectDirectory,
        env: { ...process.env, NODE_ENV: "test", REDIS_HOST: redis.host, REDIS_PORT: String(redis.port) },
        timeout: 10000,
        maxBuffer: 1024 * 1024,
      });
    } catch (error) {
      throw new Error(`File migration regression failed:\n${error.stderr || error.message}`);
    }
  }

  await t.test("received file keeps its shared token through login and sender deletion", async () => {
    await runCase(`
      const magnet = 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567';
      const sender = await createEmptyFile('merge-sender');
      await updateFile('merge-sender', sender.id, { filename: 'shared.txt', magnet });
      const draft = await createEmptyFile('merge-visitor', false);
      const received = await updateFile('merge-visitor', draft.id, {
        filename: 'shared.txt', magnet, token: sender.token, notes: 'Keep my notes', size: 42,
      });
      // Match the receive route, which releases the recipient's unused token.
      await redis.hdel('unifiedTokenMap', draft.token);
      const files = await mergeFiles('merge-account', 'merge-visitor');
      assert.equal(files.length, 1);
      assert.equal(files[0].token, sender.token, 'login must preserve the original shared token');
      assert.equal(files[0].id, received.id);
      assert.equal(files[0].notes, received.notes);
      assert.equal(files[0].size, received.size);
      assert.equal(files[0].lastEditedAt, received.lastEditedAt);
      assert.equal((await getFiles('merge-visitor')).length, 0);
      await deleteFile('merge-sender', sender.id);
      assert.equal((await getFileByToken(sender.token)).id, received.id);
      await deleteFile('merge-account', received.id);
      assert.equal(await getFileByToken(sender.token), null);
    `);
  });

  await t.test("login still reuses an existing matching account file", async () => {
    await runCase(`
      const magnet = 'magnet:?xt=urn:btih:1123456789abcdef0123456789abcdef01234567';
      const existing = await createEmptyFile('dedup-account');
      await updateFile('dedup-account', existing.id, { filename: 'duplicate.txt', magnet });
      const visitor = await createEmptyFile('dedup-visitor');
      await updateFile('dedup-visitor', visitor.id, { filename: 'duplicate.txt', magnet });
      const merged = await mergeFiles('dedup-account', 'dedup-visitor');
      assert.equal(merged.length, 1);
      assert.equal(merged[0].id, existing.id);
      assert.equal(merged[0].token, existing.token);
      assert.equal((await getFiles('dedup-visitor')).length, 0);
    `);
  });
});
