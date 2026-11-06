import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  createTransferState,
  hasActiveTransfers,
} from "../app/utils/transfer-state.ts";

class FakeTorrent extends EventEmitter {
  destroyed = false;
  done = false;
  progress = 0;
  destroyCalls = 0;

  destroy() {
    this.destroyCalls++;
    this.destroyed = true;
    this.emit("close");
  }
}

test("preparation protects pending work and each finish is idempotent", () => {
  const state = createTransferState();
  const finishFirst = state.prepare();
  const finishSecond = state.prepare();

  assert.equal(state.snapshot().preparing, 2);
  assert.equal(hasActiveTransfers(state.snapshot()), true);

  finishFirst();
  finishFirst();
  assert.equal(state.snapshot().preparing, 1);
  assert.equal(hasActiveTransfers(state.snapshot()), true);

  finishSecond();
  assert.equal(state.snapshot().preparing, 0);
  assert.equal(hasActiveTransfers(state.snapshot()), false);
});

test("leaving and returning to a route preserves the torrent and its progress", () => {
  const state = createTransferState();
  const torrent = new FakeTorrent();
  let firstRouteUpdates = 0;
  const unsubscribe = state.subscribe(() => firstRouteUpdates++);
  state.track(torrent);
  assert.equal(firstRouteUpdates, 1);

  unsubscribe();
  torrent.progress = 0.4;
  torrent.emit("download", 1024);

  assert.equal(firstRouteUpdates, 1);
  assert.equal(torrent.destroyCalls, 0);
  assert.equal(state.snapshot().downloading, 1);
  assert.equal(state.snapshot().progress, 0.4);

  let nextRouteUpdates = 0;
  const unsubscribeNext = state.subscribe(() => nextRouteUpdates++);
  torrent.progress = 0.7;
  torrent.emit("download", 1024);
  assert.equal(nextRouteUpdates, 1);
  assert.equal(state.snapshot().progress, 0.7);
  unsubscribeNext();
});

test("reusing a torrent does not duplicate activity or event subscriptions", () => {
  const state = createTransferState();
  const torrent = new FakeTorrent();
  state.track(torrent);
  const eventCounts = new Map(
    ["ready", "done", "download", "error", "close"].map((event) => [
      event,
      torrent.listenerCount(event),
    ]),
  );

  state.track(torrent);
  state.track(torrent);
  assert.equal(state.snapshot().downloading, 1);
  for (const [event, count] of eventCounts) {
    assert.equal(torrent.listenerCount(event), count, event);
  }

  let updates = 0;
  state.subscribe(() => updates++);
  torrent.progress = 0.25;
  torrent.emit("download", 1024);
  assert.equal(updates, 1);
});

test("a completed download becomes a seed and still needs unload protection", () => {
  const state = createTransferState();
  const torrent = new FakeTorrent();
  state.track(torrent);
  assert.equal(state.snapshot().downloading, 1);
  assert.equal(state.snapshot().seeding, 0);

  torrent.done = true;
  torrent.progress = 1;
  torrent.emit("done");

  assert.equal(state.snapshot().downloading, 0);
  assert.equal(state.snapshot().seeding, 1);
  assert.equal(hasActiveTransfers(state.snapshot()), true);
});

test("fatal errors and closed torrents stop contributing active transfers", () => {
  const state = createTransferState();
  const failed = new FakeTorrent();
  const closed = new FakeTorrent();
  state.track(failed);
  state.track(closed);

  failed.destroyed = true;
  failed.emit("error", new Error("Storage unavailable"));
  assert.equal(state.snapshot().downloading, 1);
  assert.equal(hasActiveTransfers(state.snapshot()), true);

  // WebTorrent emits close after error; this must not remove another torrent.
  failed.emit("close");
  assert.equal(state.snapshot().downloading, 1);

  closed.destroy();
  assert.equal(state.snapshot().downloading, 0);
  assert.equal(hasActiveTransfers(state.snapshot()), false);
});

test("destroyed torrents are ignored and completed existing torrents count as seeds", () => {
  const state = createTransferState();
  const destroyed = new FakeTorrent();
  destroyed.destroyed = true;
  state.track(destroyed);
  assert.equal(hasActiveTransfers(state.snapshot()), false);
  assert.deepEqual(destroyed.eventNames(), []);

  const existing = new FakeTorrent();
  existing.done = true;
  existing.progress = 1;
  state.track(existing);
  assert.equal(state.snapshot().seeding, 1);
  assert.equal(state.snapshot().downloading, 0);
});

test("clearing activity followed by pending completions cannot create negative counts", () => {
  const state = createTransferState();
  const finishFirst = state.prepare();
  const finishSecond = state.prepare();
  state.track(new FakeTorrent());

  state.clear();
  assert.equal(hasActiveTransfers(state.snapshot()), false);
  finishFirst();
  finishSecond();
  finishFirst();
  state.clear();

  assert.equal(state.snapshot().preparing, 0);
  assert.equal(state.snapshot().downloading, 0);
  assert.equal(state.snapshot().seeding, 0);
  assert.equal(hasActiveTransfers(state.snapshot()), false);
});

test("download links remain available when views unsubscribe and return", () => {
  const state = createTransferState();
  const unsubscribe = state.subscribe(() => {});
  state.addFile("report.txt", "blob:report");
  unsubscribe();
  state.addFile("photo.png", "blob:photo");

  assert.deepEqual(state.snapshot().files, [
    { name: "report.txt", url: "blob:report" },
    { name: "photo.png", url: "blob:photo" },
  ]);
});

test("completion from before a clear cannot cancel newly preparing work", () => {
  const state = createTransferState();
  const finishPrevious = state.prepare();
  state.clear();
  const finishCurrent = state.prepare();

  finishPrevious();
  finishPrevious();
  assert.equal(state.snapshot().preparing, 1);
  assert.equal(hasActiveTransfers(state.snapshot()), true);

  finishCurrent();
  assert.equal(state.snapshot().preparing, 0);
  assert.equal(hasActiveTransfers(state.snapshot()), false);
});
