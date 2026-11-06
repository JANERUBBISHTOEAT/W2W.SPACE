import test from "node:test";
import { storageCases } from "./share-storage-helper.mjs";

test("new text drafts can be cancelled without deleting saved text", { timeout: 60000 }, async (t) => {
  const run = await storageCases(t);
  await t.test("cancel releases the draft and token, and a new share can reuse the code", () => run(`
    const crypto = require('node:crypto');
    const original = crypto.randomInt;
    crypto.randomInt = minimum => minimum;
    try {
      const draft = await createTextShare(undefined, {draft:true});
      assert.equal(draft.draft, true);
      assert.equal(draft.token, '0');
      assert.equal((await accessTextShare(draft.id)).draft, true, 'viewing does not save the draft');
      assert.equal((await resolveToken(draft.token, true)).share.draft, true);
      assert.equal(await cancelTextDraft(draft.id), true);
      assert.equal(await getTextShare(draft.id), null);
      assert.equal(await redis.get(tokenKey(draft.token)), null);
      assert.equal(await resolveToken(draft.token), null);
      assert.equal(await cancelTextDraft(draft.id), false, 'cancel is idempotent');
      assert.equal(await editTextShare(draft.id, 'late save'), null);
      assert.equal(await accessTextShare(draft.id), null);
      const replacement = await createTextShare('replacement');
      assert.equal(replacement.token, draft.token);
      assert.notEqual(replacement.id, draft.id);
      assert.equal((await resolveToken(draft.token)).share.id, replacement.id);
      assert.equal(await cancelTextDraft(draft.id), false);
      assert.equal((await resolveToken(replacement.token)).share.id, replacement.id);
    } finally { crypto.randomInt = original; }
  `));
  await t.test("saving unchanged content commits a draft and stale cancel preserves it", () => run(`
    const draft = await createTextShare(undefined, {draft:true});
    const saved = await editTextShare(draft.id, draft.content);
    assert.equal(saved.id, draft.id);
    assert.equal(saved.token, draft.token);
    assert.equal(saved.content, draft.content);
    assert.equal('draft' in saved, false);
    assert.deepEqual(Object.keys(saved).sort(), ['content','id','lastAccessedAt','token']);
    const before = await redis.get(key('text', saved.id));
    assert.equal(await cancelTextDraft(saved.id), false);
    assert.equal(await redis.get(key('text', saved.id)), before);
    assert.equal((await resolveToken(saved.token)).share.id, saved.id);
    const legacy = await createTextShare('existing saved text');
    assert.equal('draft' in legacy, false);
    assert.equal(await cancelTextDraft(legacy.id), false);
    assert.equal((await getTextShare(legacy.id)).content, legacy.content);
  `));
  await t.test("save and cancel are atomic in either execution order", () => run(`
    for (const cancelFirst of [true, false]) {
      const draft = await createTextShare('racing draft', {draft:true});
      const operations = cancelFirst
        ? [cancelTextDraft(draft.id), editTextShare(draft.id, 'saved in another tab')]
        : [editTextShare(draft.id, 'saved in another tab'), cancelTextDraft(draft.id)];
      const results = await Promise.all(operations);
      const cancelled = results[cancelFirst ? 0 : 1];
      const saved = results[cancelFirst ? 1 : 0];
      if (cancelFirst) {
        assert.equal(cancelled, true);
        assert.equal(saved, null);
        assert.equal(await getTextShare(draft.id), null);
        assert.equal(await resolveToken(draft.token), null);
        assert.equal(await editTextShare(draft.id, 'late retry'), null);
      } else {
        assert.equal(cancelled, false);
        assert.equal(saved.content, 'saved in another tab');
        assert.equal('draft' in saved, false);
        assert.equal((await resolveToken(draft.token)).share.id, draft.id);
        assert.equal(await cancelTextDraft(draft.id), false);
      }
    }
  `));
  await t.test("cancel never deletes a token alias pointing to another share", () => run(`
    const draft = await createTextShare(undefined, {draft:true});
    const foreign = await publishShare({magnet:'magnet:?xt=urn:btih:' + 'c'.repeat(40)});
    const mapping = JSON.stringify({kind:'file', id:foreign.id});
    await redis.set(tokenKey(draft.token), mapping, 'EX', 60);
    assert.equal(await cancelTextDraft(draft.id), true);
    assert.equal(await getTextShare(draft.id), null);
    assert.equal(await redis.get(tokenKey(draft.token)), mapping);
    assert.equal((await getShare(foreign.id)).id, foreign.id);
    assert.equal((await resolveToken(foreign.token)).share.id, foreign.id);
    assert.equal(await cancelTextDraft('not-an-id'), false);
  `));
});
