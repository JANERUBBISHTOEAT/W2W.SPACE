import { toast } from "sonner";

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
  readonly files: BrowserTorrentFile[];
  on(event: "ready" | "done", listener: () => void): this;
  on(event: "download" | "upload", listener: (bytes: number) => void): this;
  on(event: "error" | "warning", listener: (error: Error | string) => void): this;
}

export interface BrowserTorrentClient {
  readonly torrents: BrowserTorrent[];
  add(magnet: string): BrowserTorrent;
  seed(file: File, callback: (torrent: BrowserTorrent) => void): BrowserTorrent;
  on(event: "error", listener: (error: Error | string) => void): this;
}

let clientPromise: Promise<BrowserTorrentClient> | undefined;

// Keep the client alive across Remix navigation so saving a seeded file does
// not stop sharing. Await initialization before accepting pasted/selected files.
export function loadTorrentClient(): Promise<BrowserTorrentClient> {
  if (!clientPromise) {
    clientPromise = import("webtorrent")
      .then(({ default: WebTorrent }) => {
        const client = new WebTorrent() as unknown as BrowserTorrentClient;
        client.on("error", () => {
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
