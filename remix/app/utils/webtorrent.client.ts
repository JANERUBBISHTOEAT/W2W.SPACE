import { toast } from "sonner";
import { prettyBytes } from "./functions";
import { createTransferState } from "./transfer-state";
import { normalizeInfoHash } from "./infohash";

// @types/webtorrent describes the pre-v2 callback API. Keep the current browser
// Promise-based file API explicit at this boundary instead of using `any`.
export interface BrowserTorrentFile {
  readonly name: string;
  readonly type?: string;
  blob(): Promise<Blob>;
}

export interface BrowserTorrent {
  readonly infoHash: string;
  readonly magnetURI: string;
  readonly name: string;
  readonly length: number;
  readonly progress: number;
  readonly downloadSpeed: number;
  readonly uploadSpeed: number;
  readonly numPeers: number;
  readonly ready: boolean;
  readonly done: boolean;
  readonly destroyed?: boolean;
  readonly files: BrowserTorrentFile[];
  on(event: "ready" | "done" | "close", listener: () => void): this;
  on(event: "download" | "upload", listener: (bytes: number) => void): this;
  on(event: "error" | "warning", listener: (error: Error | string) => void): this;
  destroy(): void;
}

export interface BrowserTorrentClient {
  readonly torrents: BrowserTorrent[];
  get(magnet: string): Promise<BrowserTorrent | null>;
  add(magnet: string): BrowserTorrent;
  seed(file: File, callback: (torrent: BrowserTorrent) => void): BrowserTorrent;
  on(event: "error", listener: (error: Error | string) => void): this;
}

const transfers = createTransferState();
export const getTransferSnapshot = transfers.snapshot;
export const subscribeTransfers = transfers.subscribe;
let clientPromise: Promise<BrowserTorrentClient> | undefined;
const receiving = new Map<string, Promise<BrowserTorrent>>();
const completed = new WeakSet<BrowserTorrent>();
const savedFiles = new WeakSet<BrowserTorrentFile>();
const saving = new WeakMap<BrowserTorrent, Promise<void>>();
const observed = new WeakSet<BrowserTorrent>();
const toastIds = new WeakMap<BrowserTorrent, string>();

// Keep the client alive across navigation: saving, searching and opening another
// page do not stop sharing. Only closing/reloading the tab interrupts transfers.
export function loadTorrentClient(): Promise<BrowserTorrentClient> {
  if (!clientPromise) {
    clientPromise = import("webtorrent")
      .then(({ default: WebTorrent }) => {
        const client = new WebTorrent() as unknown as BrowserTorrentClient;
        client.on("error", () => {
          transfers.refresh();
          toast.error("The file-sharing client failed. Please reload and try again.");
        });
        return client;
      })
      .catch((error: unknown) => {
        clientPromise = undefined;
        throw error;
      });
  }
  return clientPromise;
}

function track(torrent: BrowserTorrent) {
  transfers.track(torrent);
  if (observed.has(torrent)) return;
  observed.add(torrent);
  torrent.on("error", () => {
    toast.dismiss(toastIds.get(torrent) || `download-${torrent.infoHash}`);
    toast.error("The transfer failed. Check that the sender is still online.");
  });
}

export async function seedFile(file: File): Promise<BrowserTorrent> {
  const finishPreparing = transfers.prepare();
  try {
    const client = await loadTorrentClient();
    return await new Promise<BrowserTorrent>((resolve, reject) => {
      let settled = false;
      let seeded: BrowserTorrent | undefined;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      };
      const timer = setTimeout(() => {
        if (settled) return;
        fail(new Error("Seeding timeout"));
        seeded?.destroy();
      }, 120000);
      try {
        seeded = client.seed(file, (torrent) => {
          if (settled) return;
          if (!torrent.done) {
            fail(new Error("This file is already downloading. It will seed when complete."));
            return;
          }
          settled = true;
          clearTimeout(timer);
          // A duplicate seed can return an existing torrent, not `seeded`.
          track(torrent);
          resolve(torrent);
        });
        seeded.on("error", fail);
      } catch (error) {
        fail(error);
      }
    });
  } finally {
    finishPreparing();
  }
}

async function saveCompletedFiles(torrent: BrowserTorrent) {
  if (completed.has(torrent)) return;
  const pending = saving.get(torrent);
  if (pending) return pending;
  const operation = (async () => {
    toast.dismiss(toastIds.get(torrent) || `download-${torrent.infoHash}`);
    let failed = false;
    for (const file of torrent.files) {
      if (savedFiles.has(file)) continue;
      try {
        const url = URL.createObjectURL(await file.blob());
        transfers.addFile(file.name, url);
        const link = document.createElement("a");
        link.href = url;
        link.download = file.name;
        link.click();
        savedFiles.add(file);
      } catch {
        failed = true;
        toast.error("Could not save the downloaded file. Enter its token to try again.");
      }
    }
    if (!failed) {
      completed.add(torrent);
      toast.success("Download finished! Your file is ready for use 🎉");
    }
  })().finally(() => saving.delete(torrent));
  saving.set(torrent, operation);
  return operation;
}

function torrentIdentity(magnet: string) {
  const hash = new URLSearchParams(magnet.slice(magnet.indexOf("?") + 1)).getAll("xt")
    .find((value) => /^urn:btih:/i.test(value))?.slice(9);
  if (!hash) return magnet;
  return normalizeInfoHash(hash);
}

// Serialize duplicate receive requests until WebTorrent has parsed the infoHash.
// Different tracker/display-name parameters still identify the same torrent.
export function receiveFile(magnet: string, onReady?: (torrent: BrowserTorrent) => void): Promise<BrowserTorrent> {
  const identity = torrentIdentity(magnet);
  let operation = receiving.get(identity);
  if (!operation) {
    const finishPreparing = transfers.prepare();
    operation = loadTorrentClient().then(async (client) => {
      const torrent = await client.get(magnet) ?? client.add(magnet);
      toastIds.set(torrent, `download-${identity}`);
      track(torrent);
      if (!completed.has(torrent)) {
        const toastId = `download-${identity}`;
        const done = () => { void saveCompletedFiles(torrent); };
        if (torrent.done) done();
        else {
          toast.loading("Downloading 0%", { id: toastId });
          torrent.on("done", done);
          let lastUpdate = 0;
          torrent.on("download", () => {
            if (torrent.done || Date.now() - lastUpdate < 500) return;
            lastUpdate = Date.now();
            toast.loading(`Downloading ${(torrent.progress * 100).toFixed(1)}%`, {
              id: toastId,
              description: `${prettyBytes(torrent.downloadSpeed)}/s · ${torrent.numPeers} peers`,
            });
          });
        }
      }
      return torrent;
    }).finally(finishPreparing);
    receiving.set(identity, operation);
    void operation.then((torrent) => {
      torrent.on("close", () => receiving.delete(identity));
      torrent.on("error", () => receiving.delete(identity));
    }, () => receiving.delete(identity));
  }
  return operation.then((torrent) => {
    if (torrent.done) void saveCompletedFiles(torrent);
    if (onReady) {
      let handled = false;
      const ready = () => {
        if (handled) return;
        handled = true;
        onReady(torrent);
      };
      if (torrent.ready) ready();
      else torrent.on("ready", ready);
    }
    return torrent;
  });
}
