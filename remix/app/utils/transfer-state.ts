import type { BrowserTorrent } from "./webtorrent.client";

export interface TransferSnapshot {
  preparing: number;
  downloading: number;
  seeding: number;
  progress: number;
  files: ReadonlyArray<{ name: string; url: string }>;
}

export const EMPTY_TRANSFERS: TransferSnapshot = {
  preparing: 0, downloading: 0, seeding: 0, progress: 0, files: [],
};

// Transfers belong to the browser tab, not to a route. Unsubscribing a view
// must never destroy a torrent or remove its completion handlers.
export function createTransferState() {
  let snapshot = EMPTY_TRANSFERS;
  const preparing = new Set<object>();
  const torrents = new Set<BrowserTorrent>();
  const listeners = new Set<() => void>();
  let files: TransferSnapshot["files"] = [];
  const publish = () => {
    const active = [...torrents].filter((torrent) => !torrent.destroyed);
    const downloads = active.filter((torrent) => !torrent.done);
    const next = {
      preparing: preparing.size,
      downloading: downloads.length,
      seeding: active.length - downloads.length,
      progress: downloads.length ? Math.floor(downloads.reduce((sum, torrent) => sum + torrent.progress, 0) / downloads.length * 100) / 100 : 0,
      files,
    };
    if (snapshot.preparing === next.preparing && snapshot.downloading === next.downloading &&
      snapshot.seeding === next.seeding && snapshot.progress === next.progress && snapshot.files === next.files) return;
    snapshot = next;
    listeners.forEach((listener) => listener());
  };
  return {
    snapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    prepare() {
      const operation = {};
      preparing.add(operation);
      publish();
      let finished = false;
      return () => {
        if (finished) return;
        finished = true;
        preparing.delete(operation);
        publish();
      };
    },
    track(torrent: BrowserTorrent) {
      if (torrents.has(torrent) || torrent.destroyed) return;
      torrents.add(torrent);
      const remove = () => { torrents.delete(torrent); publish(); };
      torrent.on("ready", publish);
      torrent.on("done", publish);
      torrent.on("download", publish);
      torrent.on("close", remove);
      torrent.on("error", remove);
      publish();
    },
    addFile(name: string, url: string) {
      files = [...files, { name, url }];
      publish();
    },
    refresh: publish,
    clear() {
      torrents.clear();
      preparing.clear();
      publish();
    },
  };
}

export function hasActiveTransfers(snapshot: TransferSnapshot) {
  return snapshot.preparing + snapshot.downloading + snapshot.seeding > 0;
}
