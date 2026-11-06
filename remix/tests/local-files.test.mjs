import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { build } from "esbuild";

const compiled = await build({
  entryPoints: [fileURLToPath(new URL("../app/utils/files.local.ts", import.meta.url))],
  bundle: true,
  write: false,
  format: "cjs",
  platform: "browser",
  plugins: [{
    name: "store-only-react-boundary",
    setup(build) {
      build.onResolve({ filter: /^(react|sonner)$/ }, ({ path }) => ({ path, namespace: "boundary" }));
      build.onLoad({ filter: /.*/, namespace: "boundary" }, ({ path }) => ({
        contents: path === "react"
          ? "export const useEffect = () => {}; export const useState = () => {};"
          : "export const toast = { error: (message) => globalThis.notifications.push(message) };",
      }));
    },
  }],
});

function browser() {
  const records = new Map();
  const notifications = [];
  const module = { exports: {} };
  const storage = {
    getItem: (key) => records.get(key) ?? null,
    setItem: (key, value) => records.set(key, value),
  };
  runInNewContext(compiled.outputFiles[0].text, {
    module, exports: module.exports,
    window: { dispatchEvent() {} },
    localStorage: storage,
    crypto: { randomUUID },
    Event, notifications,
  });
  return { store: module.exports, records, storage, notifications };
}

const share = {
  id: "a".repeat(40),
  filename: "original.txt",
  type: "text/plain",
  size: 42,
  magnet: `magnet:?xt=urn:btih:${"a".repeat(40)}`,
  token: "123456",
  lastAccessedAt: "2026-11-06T00:00:00.000Z",
};

test("drafts have a stable local URL before a share or token exists", () => {
  const { store } = browser();
  const draft = store.createLocalFile();
  assert.match(draft.id, /^[a-f0-9-]{36}$/);
  assert.equal(draft.shareId, undefined);
  assert.equal(draft.share, undefined);
  const bound = store.rememberShare(share, "seed", draft.id);
  assert.equal(bound.id, draft.id);
  assert.equal(bound.shareId, share.id);
  assert.equal(store.getLocalFile(share.id).id, draft.id);
  assert.equal(store.getLocalFile(share.id.toUpperCase()).id, draft.id);
  assert.equal(store.listLocalFiles().length, 1);
});

test("personal metadata is isolated across browsers and deletion leaves the shared record intact", () => {
  const first = browser().store;
  const second = browser().store;
  const a = first.rememberShare(share);
  const b = second.rememberShare(share);
  first.putLocalFile({ ...a, displayName: "My name", notes: "Private note", favorite: true });
  first.rememberShare({ ...share, lastAccessedAt: "2026-11-07T00:00:00.000Z" });
  assert.equal(first.getLocalFile(a.id).notes, "Private note");
  assert.equal(first.getLocalFile(a.id).displayName, "My name");
  assert.equal(first.getLocalFile(a.id).favorite, true);
  assert.equal(second.getLocalFile(b.id).notes, "");
  assert.equal(second.getLocalFile(b.id).displayName, "original.txt");
  first.removeLocalFile(a.id);
  assert.equal(first.listLocalFiles().length, 0);
  assert.equal(second.listLocalFiles().length, 1);
  assert.equal(share.filename, "original.txt");
  assert.equal("notes" in share, false);
});

test("repeated publication reuses personal metadata and removes only the duplicate draft", () => {
  const { store } = browser();
  const original = store.rememberShare(share);
  store.putLocalFile({ ...original, notes: "Keep me", favorite: true });
  const draft = store.createLocalFile();
  const duplicate = store.rememberShare(share, "seed", draft.id);
  assert.equal(duplicate.id, original.id);
  assert.equal(duplicate.notes, "Keep me");
  assert.equal(duplicate.favorite, true);
  assert.equal(store.listLocalFiles().length, 1);
});

test("storage failure is visible and never reported as a saved record", () => {
  const { store, storage, notifications } = browser();
  storage.setItem = () => { throw new Error("Quota exceeded"); };
  assert.throws(() => store.createLocalFile(), /could not save your file history/);
  assert.equal(notifications.length, 1);
  assert.equal(store.listLocalFiles().length, 0);
});
