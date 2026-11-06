import test from "node:test";
import { storageCases } from "./share-storage-helper.mjs";

test("anonymous share identity and token storage", { timeout: 60000 }, async (t) => {
  const run = await storageCases(t);
  const recyclingFixtures = `
    const crypto = require('node:crypto');
    const original = crypto.randomInt;
    const blockedTokens = ['9', '99', '999', '9999', '99999', '999999'];
    async function fixture(kind, index, token, lastAccessedAt) {
      const id = kind === 'file' ? (30000 + index).toString(16).padStart(40, '0')
        : (30000 + index).toString(16).padStart(8, '0') + '-0000-4000-8000-000000000000';
      const record = { id, token, lastAccessedAt, ...(kind === 'file'
        ? { magnet: 'magnet:?xt=urn:btih:' + id, filename: 'fixture.txt', size: 7, type: 'text/plain' }
        : { content: 'fixture text' }) };
      await redis.set(key(kind, id), JSON.stringify(record), 'EX', 120);
      await redis.set(tokenKey(token), JSON.stringify({kind, id}), 'EX', 120);
      return { kind, ...record };
    }
    async function blockCandidates() {
      const blocked = [];
      for (const [index, token] of blockedTokens.entries()) {
        blocked.push(await fixture(index % 2 ? 'text' : 'file', index, token, '2024-01-01T00:00:00.000Z'));
      }
      return blocked;
    }
    async function assertResolves(record) {
      const resolved = await resolveToken(record.token);
      assert.equal(resolved?.type, record.kind);
      assert.equal(resolved?.share.id, record.id);
    }
    async function assertFreshLifetime(kind, record) {
      assert.ok(Math.abs(Date.parse(record.lastAccessedAt) - Date.now()) < 5000);
      const [recordTtl, aliasTtl] = await Promise.all([
        redis.pttl(key(kind, record.id)), redis.pttl(tokenKey(record.token)),
      ]);
      assert.ok(recordTtl > 30 * 24 * 60 * 60 * 1000 - 5000);
      assert.ok(Math.abs(recordTtl - aliasTtl) < 50, 'reused alias and new record expire together');
    }
    await redis.flushdb();
  `;
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
  await t.test("six collisions replace the globally least recently accessed Share and reuse its exact token", () => run(`
    ${recyclingFixtures}
    const blocked = await blockCandidates();
    const oldest = await fixture('file', 10, '42', '2020-01-01T00:00:00.000Z');
    const newer = await fixture('text', 11, '43', '2021-01-01T00:00:00.000Z');
    assert.equal((await getShare(oldest.id)).lastAccessedAt, oldest.lastAccessedAt);
    assert.equal((await resolveToken(oldest.token)).share.lastAccessedAt, oldest.lastAccessedAt,
      'metadata and non-touch lookup must not change eviction order');
    const snapshot = await redis.mget(...blocked.map(record => key(record.kind, record.id)), key(newer.kind, newer.id));
    const calls = [];
    crypto.randomInt = (minimum, maximum) => { calls.push([minimum, maximum]); return maximum - 1; };
    let replacement;
    try { replacement = await createTextShare('new text replaces old file'); }
    finally { crypto.randomInt = original; }
    assert.equal(calls.length, 6);
    assert.equal(replacement.token, '42', 'the victim is global, not limited to the six colliding candidates');
    assert.equal(await getShare(oldest.id), null);
    assert.equal(await accessShare(oldest.id), null, 'late access cannot resurrect the deleted Share');
    assert.equal((await resolveToken('42', true)).share.id, replacement.id);
    assert.deepEqual(JSON.parse(await redis.get(tokenKey('42'))), {kind:'text', id:replacement.id});
    assert.equal((await getTextShare(replacement.id)).content, 'new text replaces old file');
    await assertFreshLifetime('text', replacement);
    assert.deepEqual(await redis.mget(...blocked.map(record => key(record.kind, record.id)), key(newer.kind, newer.id)), snapshot);
    for (const record of [...blocked, newer]) await assertResolves(record);
    assert.equal(await redis.dbsize(), 16, 'remove the old pair and create only one new pair');
  `));
  await t.test("effective access changes eviction priority and reclaimed padded tokens retain their exact value", () => run(`
    ${recyclingFixtures}
    for (const touch of [false, true]) {
      await redis.flushdb();
      await blockCandidates();
      const oldest = await fixture('text', 12, '000007', '2019-01-01T00:00:00.000Z');
      const newer = await fixture('file', 13, '7', '2020-01-01T00:00:00.000Z');
      if (touch) {
        const edited = await editTextShare(oldest.id, 'updated old text');
        assert.ok(edited.lastAccessedAt > newer.lastAccessedAt);
        assert.ok((await accessTextShare(oldest.id)).lastAccessedAt > newer.lastAccessedAt);
      }
      crypto.randomInt = (minimum, maximum) => maximum - 1;
      let replacement;
      try { replacement = await publishShare({magnet:'magnet:?xt=urn:btih:' + 'b'.repeat(40)}); }
      finally { crypto.randomInt = original; }
      assert.equal(replacement.token, touch ? '7' : '000007');
      if (touch) {
        assert.equal(await getShare(newer.id), null);
        assert.equal((await getTextShare(oldest.id)).content, 'updated old text');
        await assertResolves(oldest);
      } else {
        assert.equal(await getTextShare(oldest.id), null);
        assert.equal(await editTextShare(oldest.id, 'late save'), null);
        await assertResolves(newer);
      }
      assert.equal((await resolveToken(replacement.token)).share.id, replacement.id);
      await assertFreshLifetime('file', replacement);
      assert.equal(await redis.dbsize(), 16);
    }
  `));
  await t.test("a free candidate leaves even the oldest record untouched", () => run(`
    ${recyclingFixtures}
    const oldest = await fixture('text', 14, '42', '2010-01-01T00:00:00.000Z');
    const before = await redis.get(key(oldest.kind, oldest.id));
    let calls = 0;
    crypto.randomInt = minimum => { calls++; return minimum; };
    let replacement;
    try { replacement = await createTextShare('uses the available short code'); }
    finally { crypto.randomInt = original; }
    assert.equal(calls, 1);
    assert.equal(replacement.token, '0');
    assert.equal(await redis.get(key(oldest.kind, oldest.id)), before);
    await assertResolves(oldest);
    await assertFreshLifetime('text', replacement);
  `));
  await t.test("mismatched aliases are not reclaimed from an unrelated record", () => run(`
    ${recyclingFixtures}
    await blockCandidates();
    const mismatch = await fixture('file', 15, '42', '2000-01-01T00:00:00.000Z');
    const owner = await fixture('text', 16, '42', '2022-01-01T00:00:00.000Z');
    const validOldest = await fixture('file', 17, '43', '2020-01-01T00:00:00.000Z');
    crypto.randomInt = (minimum, maximum) => maximum - 1;
    let replacement;
    try { replacement = await createTextShare('replace only a matching record and alias'); }
    finally { crypto.randomInt = original; }
    assert.equal(replacement.token, '43');
    assert.notEqual(await getShare(mismatch.id), null);
    assert.equal(await getShare(validOldest.id), null);
    await assertResolves(owner);
    assert.equal((await resolveToken('43')).share.id, replacement.id);
  `));
  await t.test("access between selection and reclamation preserves the selected Share", () => run(`
    ${recyclingFixtures}
    const blocked = await blockCandidates();
    const selected = await fixture('file', 20, '42', '2019-01-01T00:00:00.000Z');
    const next = await fixture('text', 21, '43', '2020-01-01T00:00:00.000Z');
    const originalEval = Redis.prototype.eval;
    let accessed = false;
    let attempts = 0;
    // Schedule real access after selection but before the atomic reclamation.
    Redis.prototype.eval = async function(script, keyCount, ...args) {
      if (Number(keyCount) === 3) {
        attempts++;
        if (!accessed) {
          assert.equal(args[1], key(selected.kind, selected.id));
          accessed = true;
          await accessShare(selected.id);
        }
      }
      return originalEval.call(this, script, keyCount, ...args);
    };
    crypto.randomInt = (minimum, maximum) => maximum - 1;
    let replacement;
    try { replacement = await createTextShare('must reselect after a concurrent access'); }
    finally { Redis.prototype.eval = originalEval; crypto.randomInt = original; }
    assert.equal(accessed, true);
    assert.ok(attempts >= 2);
    assert.equal(replacement.token, next.token);
    assert.equal(await getTextShare(next.id), null);
    assert.ok((await getShare(selected.id)).lastAccessedAt > next.lastAccessedAt);
    for (const survivor of [...blocked, selected]) await assertResolves(survivor);
    assert.equal((await resolveToken(next.token)).share.id, replacement.id);
    assert.equal(await redis.dbsize(), 16);
  `));
  await t.test("a candidate released during selection is used without evicting another Share", () => run(`
    ${recyclingFixtures}
    const blocked = await blockCandidates();
    const selected = await fixture('text', 22, '42', '2019-01-01T00:00:00.000Z');
    const before = await redis.get(key(selected.kind, selected.id));
    const released = blocked[2];
    const originalEval = Redis.prototype.eval;
    let removed = false;
    Redis.prototype.eval = async function(script, keyCount, ...args) {
      if (Number(keyCount) === 3 && !removed) {
        assert.equal(args[1], key(selected.kind, selected.id));
        removed = true;
        await redis.del(key(released.kind, released.id), tokenKey(released.token));
      }
      return originalEval.call(this, script, keyCount, ...args);
    };
    crypto.randomInt = (minimum, maximum) => maximum - 1;
    let replacement;
    try { replacement = await createTextShare('use the candidate released while searching'); }
    finally { Redis.prototype.eval = originalEval; crypto.randomInt = original; }
    assert.equal(removed, true);
    assert.equal(replacement.token, released.token);
    assert.equal(await redis.get(key(selected.kind, selected.id)), before);
    assert.equal(await redis.get(key(released.kind, released.id)), null);
    for (const survivor of [...blocked.filter(record => record !== released), selected]) await assertResolves(survivor);
    assert.equal((await resolveToken(released.token)).share.id, replacement.id);
    await assertFreshLifetime('text', replacement);
    assert.equal(await redis.dbsize(), 14);
  `));
  await t.test("a delayed renewal cannot move last access backwards", () => run(`
    ${recyclingFixtures}
    const existing = await fixture('text', 23, '42', '2019-01-01T00:00:00.000Z');
    const earlierTime = '2020-01-01T00:00:00.000Z';
    const laterTime = '2021-01-01T00:00:00.000Z';
    const originalEval = Redis.prototype.eval;
    let releaseEarlier;
    let signalQueued;
    const gate = new Promise(resolve => { releaseEarlier = resolve; });
    const queued = new Promise(resolve => { signalQueued = resolve; });
    let intercepted = 0;
    Redis.prototype.eval = async function(script, keyCount, ...args) {
      if (Number(keyCount) === 1 && args[0] === key(existing.kind, existing.id)) {
        const first = intercepted++ === 0;
        // ARGV[2] is the request timestamp, following the key and TTL.
        args[Number(keyCount) + 1] = first ? earlierTime : laterTime;
        if (first) { signalQueued(); await gate; }
      }
      return originalEval.call(this, script, keyCount, ...args);
    };
    const delayed = accessTextShare(existing.id);
    try {
      await queued;
      const later = await editTextShare(existing.id, 'saved by the later request');
      assert.equal(later.lastAccessedAt, laterTime);
      releaseEarlier();
      const earlier = await delayed;
      assert.equal(earlier.lastAccessedAt, laterTime);
      assert.equal(earlier.content, 'saved by the later request');
      assert.equal((await getTextShare(existing.id)).lastAccessedAt, laterTime);
      assert.equal(earlier.token, existing.token);
      await assertResolves(existing);
    } finally {
      releaseEarlier();
      Redis.prototype.eval = originalEval;
      await delayed;
    }
    assert.equal(intercepted, 2);
  `));
  await t.test("concurrent fallback allocations preserve unique aliases and existing publication identity", () => run(`
    ${recyclingFixtures}
    for (const identical of [false, true]) {
      await redis.flushdb();
      const blocked = await blockCandidates();
      const victims = [];
      for (let index = 0; index < 16; index++) {
        victims.push(await fixture(index % 2 ? 'text' : 'file', 100 + index, String(50 + index),
          new Date(Date.UTC(2010, 0, index + 1)).toISOString()));
      }
      crypto.randomInt = (minimum, maximum) => maximum - 1;
      let shares;
      try {
        shares = await Promise.all(Array.from({length:8}, (_, index) => identical || index % 2 === 0
          ? publishShare({magnet:'magnet:?xt=urn:btih:' + (50000 + (identical ? 0 : index)).toString(16).padStart(40, '0')})
          : createTextShare('concurrent replacement ' + index)));
      } finally { crypto.randomInt = original; }
      const removed = identical ? 1 : 8;
      assert.equal(new Set(shares.map(record => record.id)).size, removed);
      assert.equal(new Set(shares.map(record => record.token)).size, removed);
      assert.deepEqual([...new Set(shares.map(record => record.token))].sort(), victims.slice(0, removed).map(record => record.token).sort());
      for (const record of shares) assert.equal((await resolveToken(record.token)).share.id, record.id);
      for (const victim of victims.slice(0, removed)) assert.equal(await redis.get(key(victim.kind, victim.id)), null);
      for (const survivor of [...victims.slice(removed), ...blocked]) await assertResolves(survivor);
      assert.equal(await redis.dbsize(), 44, 'concurrent losers must not leak aliases or remove extra shares');
    }
  `));
  await t.test("orphan-only collisions fail without overwriting unrelated aliases", () => run(`
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
