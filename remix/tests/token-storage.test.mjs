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
  await t.test("collisions advance one digit while existing tokens stay stable", () => run(`
    // This Redis instance belongs exclusively to this regression suite.
    await redis.flushdb();
    const crypto = require('node:crypto');
    const original = crypto.randomInt;
    const ranges = [[0, 10], [10, 100], [100, 1000], [1000, 10000], [10000, 100000], [100000, 1000000]];
    const published = [];
    try {
      for (let length = 1; length <= 6; length++) {
        const calls = [];
        crypto.randomInt = (minimum, maximum) => {
          assert.deepEqual([minimum, maximum], ranges[calls.length]);
          calls.push([minimum, maximum]);
          return minimum;
        };
        const share = length % 2
          ? await createTextShare('shortest candidate first')
          : await publishShare({magnet:'magnet:?xt=urn:btih:' + (2000 + length).toString(16).padStart(40, '0')});
        assert.deepEqual(calls, ranges.slice(0, length), 'try exactly one candidate per length, starting at one digit');
        assert.equal(share.token, String(ranges[length - 1][0]));
        assert.equal(share.token.length, length);
        assert.equal((await resolveToken(share.token, true)).share.id, share.id);
        // The sampled candidate collides, but other codes of that length are
        // still free: the requested rule advances rather than scanning them.
        assert.equal(await redis.exists(tokenKey('1')), 0);
        assert.equal(await redis.exists(tokenKey('11')), 0);
        published.push(share);
      }
    } finally { crypto.randomInt = original; }
    for (const share of published) assert.equal((await resolveToken(share.token)).share.id, share.id);
    const hash = '4'.repeat(40);
    const padded = {id:hash, token:'000007', magnet:'magnet:?xt=urn:btih:' + hash, filename:'old.txt', size:7, type:'text/plain', lastAccessedAt:new Date().toISOString()};
    await redis.set(key('file', hash), JSON.stringify(padded), 'EX', 60);
    await redis.set(tokenKey(padded.token), JSON.stringify({kind:'file', id:hash}), 'EX', 60);
    assert.equal((await resolveToken('000007', true)).share.id, hash);
    let repeatedCalls = 0;
    crypto.randomInt = (minimum, maximum) => {
      assert.deepEqual([minimum, maximum], ranges[0]);
      repeatedCalls++;
      return 0; // Occupied by the first text Share above.
    };
    try { assert.equal((await publishShare({magnet:padded.magnet, filename:'changed.txt'})).token, '000007'); }
    finally { crypto.randomInt = original; }
    assert.equal(repeatedCalls, 1, 'an existing Share reuses its token despite the candidate collision');
    assert.equal((await resolveToken('0')).share.id, published[0].id);
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
  await t.test("six colliding candidates fail without overwriting any alias", () => run(`
    await redis.flushdb();
    const crypto = require('node:crypto');
    const original = crypto.randomInt;
    const ranges = [[0, 10], [10, 100], [100, 1000], [1000, 10000], [10000, 100000], [100000, 1000000]];
    const occupied = ranges.map(([, maximum], index) => ({token:String(maximum - 1), mapping:JSON.stringify({kind:index % 2 ? 'file' : 'text', id:'occupied-' + index})}));
    for (const entry of occupied) await redis.set(tokenKey(entry.token), entry.mapping);
    const calls = [];
    crypto.randomInt = (minimum, maximum) => {
      assert.deepEqual([minimum, maximum], ranges[calls.length]);
      calls.push([minimum, maximum]);
      return maximum - 1;
    };
    try { await assert.rejects(publishShare({magnet:'magnet:?xt=urn:btih:' + '3'.repeat(40)}), /unique sharing token/); }
    finally { crypto.randomInt = original; }
    assert.deepEqual(calls, ranges, 'stop after one candidate at each of the six allowed lengths');
    for (const entry of occupied) assert.equal(await redis.get(tokenKey(entry.token)), entry.mapping);
    assert.equal(await getShare('3'.repeat(40)), null);
    assert.equal(await redis.dbsize(), 6, 'failure must not leak a record or a new alias');
  `));
});
