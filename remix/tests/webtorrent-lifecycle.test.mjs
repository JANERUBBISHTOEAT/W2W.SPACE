import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// Exercise the actual helper and transfer registry. Only the external torrent
// transport and toast renderer are substituted; no production test hooks needed.
const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL("../app/utils/webtorrent.client.ts", import.meta.url))],
  bundle: true,
  write: false,
  platform: "browser",
  format: "cjs",
  plugins: [{
    name: "browser-module-boundaries",
    setup(builder) {
      builder.onResolve({ filter: /^(webtorrent|sonner)$/ }, (args) => ({
        path: args.path,
        namespace: "test-boundary",
      }));
      builder.onLoad({ filter: /.*/, namespace: "test-boundary" }, (args) => ({
        contents: args.path === "sonner"
          ? "export const toast = globalThis.testToast;"
          : `export default class WebTorrent {
              constructor() {
                globalThis.clientConstructions++;
                return globalThis.testClient;
              }
            }`,
        loader: "js",
      }));
    },
  }],
});
const helperSource = outputFiles[0].text;
const hash = "f".repeat(40);
const magnet = `magnet:?xt=urn:btih:${hash}`;

class FakeTorrent extends EventEmitter {
  infoHash = hash;
  magnetURI = magnet;
  name = "example.txt";
  length = 7;
  progress = 0;
  downloadSpeed = 1024;
  uploadSpeed = 0;
  numPeers = 1;
  ready = false;
  done = false;
  destroyed = false;
  files = [];
  destroyCalls = 0;

  destroy() {
    this.destroyCalls++;
    this.destroyed = true;
    this.emit("close");
  }
}

class FakeClient extends EventEmitter {
  torrents = [];
  getCalls = [];
  addCalls = [];
  seedCalls = [];
  nextTorrent = new FakeTorrent();
  seedImplementation;

  async get(value) {
    this.getCalls.push(value);
    return this.torrents.find((torrent) => !torrent.destroyed) ?? null;
  }

  add(value) {
    this.addCalls.push(value);
    this.torrents.push(this.nextTorrent);
    return this.nextTorrent;
  }

  seed(file, callback) {
    this.seedCalls.push(file);
    if (!this.seedImplementation) throw new Error("Unexpected seed call");
    return this.seedImplementation(file, callback);
  }
}

function fixture(client = new FakeClient()) {
  const toastCalls = [];
  const downloads = [];
  const blobURLs = [];
  const timers = new Map();
  let timerID = 0;
  const context = vm.createContext({
    module: { exports: {} },
    testClient: client,
    clientConstructions: 0,
    testToast: Object.fromEntries(["loading", "success", "error", "dismiss"].map((kind) => [
      kind,
      (...args) => toastCalls.push({ kind, args }),
    ])),
    URLSearchParams,
    URL: {
      createObjectURL(blob) {
        const url = `blob:test-${blobURLs.length + 1}`;
        blobURLs.push({ blob, url });
        return url;
      },
    },
    document: {
      createElement(tag) {
        assert.equal(tag, "a");
        return {
          href: "",
          download: "",
          click() { downloads.push({ href: this.href, name: this.download }); },
        };
      },
    },
    setTimeout(callback, delay) {
      const id = ++timerID;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
  });
  vm.runInContext(helperSource, context, { filename: "webtorrent-helper.bundle.cjs" });
  return {
    api: context.module.exports,
    client,
    context,
    toastCalls,
    downloads,
    blobURLs,
    timers,
  };
}

test("the browser client initializes lazily once for concurrent callers", async () => {
  const { api, client, context } = fixture();
  assert.equal(context.clientConstructions, 0);
  const first = api.loadTorrentClient();
  const second = api.loadTorrentClient();
  assert.equal(first, second);
  const clients = await Promise.all([first, second, api.loadTorrentClient()]);
  for (const result of clients) assert.equal(result, client);
  assert.equal(context.clientConstructions, 1);
});

test("concurrent hex/base32 magnets with different trackers share one download", async () => {
  const { api, client } = fixture();
  // Twenty 0xff bytes encode as 40 hex F characters or 32 base32 7 characters.
  const alternatives = [
    `${magnet}&tr=wss%3A%2F%2Ffirst.example%2Fannounce`,
    `magnet:?xt=urn:btih:${hash.toUpperCase()}&dn=Other+name`,
    `magnet:?tr=wss%3A%2F%2Fsecond.example&xt=urn:btih:${"7".repeat(32)}`,
  ];
  const results = await Promise.all(alternatives.map((value) => api.receiveFile(value)));

  assert.equal(client.getCalls.length, 1);
  assert.equal(client.addCalls.length, 1);
  for (const torrent of results) assert.equal(torrent, client.nextTorrent);
  assert.equal(api.getTransferSnapshot().preparing, 0);
  assert.equal(api.getTransferSnapshot().downloading, 1);
});

test("completion changes download to seeding and saves each file only once", async () => {
  const { api, client, downloads, blobURLs, toastCalls } = fixture();
  let blobReads = 0;
  client.nextTorrent.files = [{
    name: "example.txt",
    async blob() { blobReads++; return new Blob(["example"]); },
  }];
  const torrent = await api.receiveFile(magnet);
  assert.equal(api.getTransferSnapshot().downloading, 1);
  torrent.progress = 1;
  torrent.done = true;
  torrent.emit("done");
  torrent.emit("done");
  await setImmediate();
  await api.receiveFile(`${magnet}&dn=Repeated`);
  await setImmediate();

  assert.equal(api.getTransferSnapshot().downloading, 0);
  assert.equal(api.getTransferSnapshot().seeding, 1);
  assert.equal(blobReads, 1);
  assert.equal(blobURLs.length, 1);
  assert.deepEqual(downloads, [{ href: "blob:test-1", name: "example.txt" }]);
  assert.equal(api.getTransferSnapshot().files.length, 1);
  assert.equal(toastCalls.filter((call) => call.kind === "success").length, 1);
});

test("a client-level error does not hide torrents that remain active", async () => {
  const { api, client, toastCalls } = fixture();
  const torrent = await api.receiveFile(magnet);
  client.emit("error", new Error("Tracker temporarily unavailable"));

  assert.equal(torrent.destroyed, false);
  assert.equal(api.getTransferSnapshot().downloading, 1);
  assert.equal(api.getTransferSnapshot().preparing, 0);
  assert.equal(toastCalls.filter((call) => call.kind === "error").length, 1);
});

test("synchronous seed failure immediately clears preparation and its timeout", async () => {
  const { api, client, timers } = fixture();
  client.seedImplementation = () => { throw new Error("Cannot read selected file"); };
  const operation = api.seedFile({ name: "unreadable.txt" });
  assert.equal(api.getTransferSnapshot().preparing, 1);
  await assert.rejects(operation, /Cannot read selected file/);

  assert.equal(api.getTransferSnapshot().preparing, 0);
  assert.equal(api.getTransferSnapshot().downloading, 0);
  assert.equal(api.getTransferSnapshot().seeding, 0);
  assert.equal(timers.size, 0);
});

test("a duplicate seed returning an incomplete download rejects without interrupting it", async () => {
  const { api, client, timers } = fixture();
  const downloading = await api.receiveFile(magnet);
  client.seedImplementation = (_file, callback) => {
    const temporary = new FakeTorrent();
    queueMicrotask(() => { temporary.destroy(); callback(downloading); });
    return temporary;
  };

  await assert.rejects(api.seedFile({ name: "example.txt" }), /already downloading.*seed when complete/i);
  assert.equal(downloading.destroyCalls, 0);
  assert.equal(api.getTransferSnapshot().downloading, 1);
  assert.equal(api.getTransferSnapshot().seeding, 0);
  assert.equal(api.getTransferSnapshot().preparing, 0);
  assert.equal(timers.size, 0);
});

test("seed callbacks returning a different existing torrent register it only once", async () => {
  const { api, client, timers } = fixture();
  const existing = new FakeTorrent();
  existing.done = true;
  existing.ready = true;
  existing.progress = 1;
  const temporaryTorrents = [];
  client.seedImplementation = (_file, callback) => {
    const temporary = new FakeTorrent();
    temporaryTorrents.push(temporary);
    queueMicrotask(() => { temporary.destroy(); callback(existing); });
    return temporary;
  };

  assert.equal(await api.seedFile({ name: "example.txt" }), existing);
  const doneListeners = existing.listenerCount("done");
  const errorListeners = existing.listenerCount("error");
  assert.equal(await api.seedFile({ name: "example.txt" }), existing);
  assert.equal(api.getTransferSnapshot().seeding, 1);
  assert.equal(api.getTransferSnapshot().downloading, 0);
  assert.equal(api.getTransferSnapshot().preparing, 0);
  assert.equal(existing.listenerCount("done"), doneListeners);
  assert.equal(existing.listenerCount("error"), errorListeners);
  assert.equal(existing.destroyCalls, 0);
  assert.equal(temporaryTorrents.every((torrent) => torrent.destroyed), true);
  assert.equal(timers.size, 0);
});

test("retrying a failed save keeps successful files and retries only missing files", async () => {
  const { api, client, downloads } = fixture();
  let successfulReads = 0;
  let retriedReads = 0;
  client.nextTorrent.files = [
    { name: "first.txt", async blob() { successfulReads++; return new Blob(["first"]); } },
    {
      name: "second.txt",
      async blob() {
        retriedReads++;
        if (retriedReads === 1) throw new Error("Temporary save failure");
        return new Blob(["second"]);
      },
    },
  ];
  const torrent = await api.receiveFile(magnet);
  torrent.done = true;
  torrent.progress = 1;
  torrent.emit("done");
  await setImmediate();
  assert.equal(downloads.length, 1);

  await api.receiveFile(magnet);
  await setImmediate();
  assert.equal(successfulReads, 1);
  assert.equal(retriedReads, 2);
  assert.deepEqual(downloads.map((file) => file.name), ["first.txt", "second.txt"]);
  assert.equal(api.getTransferSnapshot().files.length, 2);
});
