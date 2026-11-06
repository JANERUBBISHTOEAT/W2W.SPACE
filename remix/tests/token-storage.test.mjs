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
    assert.match(first.token, /^\\d{1,6}$/);
    for (const field of ['filename', 'magnet', 'size', 'type']) assert.equal(second[field], first[field]);
    for (const field of ['notes', 'favorite', 'owner', 'userId', 'displayName']) assert.equal(field in second, false);
    assert.equal((await redis.keys('w2w:v2:share:file:*')).length, 1);
    assert.deepEqual(await redis.keys('user:*'), []);
    assert.throws(() => parseMagnet('magnet:?xt=urn:btih:' + hash + '&xt=urn:btih:' + 'f'.repeat(40)), /unambiguous/);
    assert.throws(() => parseMagnet('magnet:?xt=urn:btih:not-a-hash'), /infoHash/);
  `));
  await t.test("all token lengths resolve exactly and old padded tokens stay stable", () => run(`
    const crypto = require('node:crypto');
    const original = crypto.randomInt;
    try {
      for (let length = 1; length <= 6; length++) {
        let candidate = length === 1 ? 0 : 10 ** (length - 1);
        while (await redis.exists(tokenKey(String(candidate)))) candidate++;
        assert.equal(String(candidate).length, length);
        crypto.randomInt = (minimum, maximum) => minimum === 1 && maximum === 7 ? length : candidate;
        const share = length % 2
          ? await createTextShare('variable length token')
          : await publishShare({magnet:'magnet:?xt=urn:btih:' + (2000 + length).toString(16).padStart(40, '0')});
        assert.equal(share.token, String(candidate));
        assert.equal(share.token.length, length);
        assert.equal((await resolveToken(share.token, true)).share.id, share.id);
      }
    } finally { crypto.randomInt = original; }
    const hash = '4'.repeat(40);
    const padded = {id:hash, token:'000007', magnet:'magnet:?xt=urn:btih:' + hash, filename:'old.txt', size:7, type:'text/plain', lastAccessedAt:new Date().toISOString()};
    await redis.set(key('file', hash), JSON.stringify(padded), 'EX', 60);
    await redis.set(tokenKey(padded.token), JSON.stringify({kind:'file', id:hash}), 'EX', 60);
    assert.equal((await resolveToken('000007', true)).share.id, hash);
    assert.equal((await publishShare({magnet:padded.magnet, filename:'changed.txt'})).token, '000007');
    assert.equal((await getShare(hash)).filename, 'old.txt');
    for (const invalid of ['', '1234567', '-1', '1.2', 'abc', ' 7']) assert.equal(await resolveToken(invalid), null);
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
  await t.test("files and texts share one collision-safe variable-length token namespace", () => run(`
    const shares = await Promise.all(Array.from({length: 64}, (_, i) => i % 2
      ? createTextShare('same text')
      : publishShare({magnet: 'magnet:?xt=urn:btih:' + (1000 + i).toString(16).padStart(40, '0')})));
    assert.equal(new Set(shares.map(s => s.token)).size, 64);
    for (const share of shares) {
      assert.match(share.token, /^\\d{1,6}$/);
      assert.equal((await resolveToken(share.token)).share.id, share.id);
    }
  `));
  await t.test("bounded token exhaustion never replaces an occupied alias", () => run(`
    const crypto = require('node:crypto');
    const original = crypto.randomInt;
    const occupied = JSON.stringify({kind:'text', id:'occupied'});
    await redis.set(tokenKey('42'), occupied);
    let calls = 0;
    crypto.randomInt = (minimum, maximum) => { calls++; return minimum === 1 && maximum === 7 ? 2 : 42; };
    try { await assert.rejects(publishShare({magnet:'magnet:?xt=urn:btih:' + '3'.repeat(40)}), /unique sharing token/); }
    finally { crypto.randomInt = original; }
    assert.equal(calls, 128, 'allocation must stop after 64 two-draw attempts');
    assert.equal(await redis.get(tokenKey('42')), occupied);
    assert.equal(await getShare('3'.repeat(40)), null);
  `));
});
