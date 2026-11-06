import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { build } from "esbuild";

const compiled = await build({
  entryPoints: [fileURLToPath(new URL("../app/utils/texts.local.ts", import.meta.url))],
  bundle: true, write: false, format: "cjs", platform: "browser",
  plugins: [{
    name: "local-history-react-boundary",
    setup(build) {
      build.onResolve({ filter: /^(react|sonner)$/ }, ({ path }) => ({ path, namespace: "boundary" }));
      build.onLoad({ filter: /.*/, namespace: "boundary" }, ({ path }) => ({
        contents: path === "react"
          ? "export const useEffect = (effect) => globalThis.cleanups.push(effect()); export const useState = () => [[], value => globalThis.updates.push(value)];"
          : "export const toast = { error: (message) => globalThis.notifications.push(message) };",
      }));
    },
  }],
});

function browser(records = new Map()) {
  const notifications = [];
  const cleanups = [];
  const updates = [];
  const module = { exports: {} };
  const window = new EventTarget();
  const storage = {
    getItem: (key) => records.get(key) ?? null,
    setItem: (key, value) => records.set(key, value),
  };
  runInNewContext(compiled.outputFiles[0].text, {
    module, exports: module.exports, window, localStorage: storage,
    Event, notifications, cleanups, updates,
  });
  return { store: module.exports, records, storage, notifications, window, updates, cleanups };
}

const text = {
  id: "12345678-1234-4123-8123-123456789012",
  token: "7",
  title: "Saved title",
  lastAccessedAt: "2026-11-06T00:00:00.000Z",
};

test("successful save summaries retain metadata only and repeated saves update one entry", () => {
  const { store, records } = browser();
  const first = store.rememberText({ ...text, content: "private text body", draft: true, owner: "account" });
  const updated = store.rememberText({ ...text, title: "Updated title", token: "000007", lastAccessedAt: "2026-11-07T00:00:00.000Z" });
  assert.equal(store.listLocalTexts().length, 1);
  assert.equal(updated.createdAt, first.createdAt);
  assert.equal(store.getLocalText(text.id).title, "Updated title");
  assert.equal(store.getLocalText(text.id).token, "000007");
  assert.deepEqual(Object.keys(JSON.parse(records.get(store.LOCAL_TEXTS_KEY))[0]).sort(),
    ["createdAt", "id", "lastAccessedAt", "title", "token"]);
  assert.equal(records.size, 1);
});

test("text history belongs to its browser and reads do not add entries", () => {
  const first = browser().store;
  const second = browser().store;
  assert.equal(first.getLocalText(text.id), undefined);
  first.rememberText(text);
  assert.equal(second.getLocalText(text.id), undefined);
  assert.equal(second.listLocalTexts().length, 0);
  assert.equal(first.listLocalTexts().length, 1);
  assert.equal("createdAt" in text, false);
});

test("same-tab saves and cross-tab storage events refresh subscribed history", () => {
  const first = browser();
  const second = browser(first.records);
  first.store.useLocalTexts();
  second.store.useLocalTexts();
  assert.equal(first.updates.at(-1).length, 0);
  assert.equal(second.updates.at(-1).length, 0);
  first.store.rememberText(text);
  assert.equal(first.updates.at(-1)[0].id, text.id);
  assert.equal(second.updates.at(-1).length, 0);
  second.window.dispatchEvent(new Event("storage"));
  assert.equal(second.updates.at(-1)[0].id, text.id);
  const updatesBeforeCleanup = first.updates.length;
  first.cleanups.forEach(cleanup => cleanup());
  first.store.rememberText({ ...text, title: "Changed again" });
  assert.equal(first.updates.length, updatesBeforeCleanup);
});

test("malformed history cannot introduce invalid links or leak extra fields", () => {
  const { store, records } = browser();
  records.set(store.LOCAL_TEXTS_KEY, "not json");
  assert.equal(store.listLocalTexts().length, 0);
  records.set(store.LOCAL_TEXTS_KEY, JSON.stringify([
    { ...text, createdAt: text.lastAccessedAt, content: "unexpected body" },
    { ...text, createdAt: text.lastAccessedAt },
    { ...text, createdAt: text.lastAccessedAt, id: "../elsewhere" },
    null,
  ]));
  const entries = store.listLocalTexts();
  assert.equal(entries.length, 1);
  assert.equal("content" in entries[0], false);
});

test("storage failures are visible and cannot look like a saved history entry", () => {
  const { store, storage, notifications, updates } = browser();
  store.useLocalTexts();
  storage.setItem = () => { throw new Error("Quota exceeded"); };
  assert.throws(() => store.rememberText(text), /could not save your text history/);
  assert.equal(notifications.length, 1);
  assert.equal(store.listLocalTexts().length, 0);
  assert.equal(updates.length, 1, "no change event follows a failed write");
});
