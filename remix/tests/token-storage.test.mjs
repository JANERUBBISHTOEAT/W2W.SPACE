import test from "node:test";
import { storageCases } from "./share-storage-helper.mjs";

test("anonymous share identity and token storage", { timeout: 60000 }, async (t) => {
  const run = await storageCases(t);
  await t.test("hex/base32 identity ignores tracker and query differences", () => run(`
    const hash = '0123456789abcdef0123456789abcdef01234567';
    assert.equal(normalizeInfoHash(hash.toUpperCase()), hash);
    assert.equal(normalizeInfoHash('AERUKZ4JVPG66AJDIVTYTK6N54ASGRLH'), hash);
    const first = await publishShare({ magnet: 'magnet:?xt=urn:btih:' + hash.toUpperCase() + '&dn=original.txt&tr=wss%3A%2F%2Fone.example', filename: 'original.txt', size: 42, type: 'text/plain' });
    const second = await publishShare({ magnet: 'magnet:?tr=wss%3A%2F%2Ftwo.example&xt=urn:btih:AERUKZ4JVPG66AJDIVTYTK6N54ASGRLH&dn=renamed.txt', filename: 'renamed.txt', size: 100, type: 'image/png', notes: 'private', favorite: true, owner: true });
    assert.equal(first.id, hash);
    assert.equal(second.id, first.id);
    assert.equal(second.token, first.token);
    assert.match(first.token, /^\\d{6}$/);
    for (const field of ['filename', 'magnet', 'size', 'type']) assert.equal(second[field], first[field]);
    for (const field of ['notes', 'favorite', 'owner', 'userId', 'displayName']) assert.equal(field in second, false);
    assert.equal((await redis.keys('w2w:v2:share:file:*')).length, 1);
    assert.deepEqual(await redis.keys('user:*'), []);
    assert.throws(() => parseMagnet('magnet:?xt=urn:btih:' + hash + '&xt=urn:btih:' + 'f'.repeat(40)), /unambiguous/);
    assert.throws(() => parseMagnet('magnet:?xt=urn:btih:not-a-hash'), /infoHash/);
  `));
  await t.test("concurrent identical publishers allocate exactly one token", () => run(`
    const magnet = 'magnet:?xt=urn:btih:' + '2'.repeat(40);
    const shares = await Promise.all(Array.from({length: 32}, () => publishShare({magnet})));
    assert.equal(new Set(shares.map(s => s.id)).size, 1);
    assert.equal(new Set(shares.map(s => s.token)).size, 1);
    const aliases = await redis.keys('w2w:v2:token:*');
    let count = 0;
    for (const alias of aliases) if (JSON.parse(await redis.get(alias)).id === shares[0].id) count++;
    assert.equal(count, 1, 'losing publishers must not leak provisional token aliases');
  `));
  await t.test("files and texts share one collision-safe fixed-length token namespace", () => run(`
    const shares = await Promise.all(Array.from({length: 64}, (_, i) => i % 2
      ? createTextShare('same text')
      : publishShare({magnet: 'magnet:?xt=urn:btih:' + (1000 + i).toString(16).padStart(40, '0')})));
    assert.equal(new Set(shares.map(s => s.token)).size, 64);
    for (const share of shares) {
      assert.match(share.token, /^\\d{6}$/);
      assert.equal((await resolveToken(share.token)).share.id, share.id);
    }
  `));
  await t.test("bounded token exhaustion never replaces an occupied alias", () => run(`
    const crypto = require('node:crypto');
    const original = crypto.randomInt;
    const occupied = JSON.stringify({kind:'text', id:'occupied'});
    await redis.set(tokenKey('000042'), occupied);
    crypto.randomInt = () => 42;
    try { await assert.rejects(publishShare({magnet:'magnet:?xt=urn:btih:' + '3'.repeat(40)}), /unique sharing token/); }
    finally { crypto.randomInt = original; }
    assert.equal(await redis.get(tokenKey('000042')), occupied);
    assert.equal(await getShare('3'.repeat(40)), null);
  `));
});
