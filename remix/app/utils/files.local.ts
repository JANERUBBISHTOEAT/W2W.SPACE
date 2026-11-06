import { useEffect, useState } from "react";
import { toast } from "sonner";

export interface PublicShare {
  id: string;
  magnet: string;
  filename: string;
  type: string;
  size: number;
  token: string;
  lastAccessedAt: string;
}

export interface LocalFile {
  id: string;
  shareId?: string;
  displayName: string;
  notes: string;
  favorite: boolean;
  createdAt: string;
  direction: "seed" | "receive";
  // Public metadata is a cache, never the authority for availability or expiry.
  share?: PublicShare;
  status?: "expired";
}

export const LOCAL_FILES_KEY = "w2w.files.v1";
const changeEvent = "w2w:files-changed";

export function listLocalFiles(): LocalFile[] {
  if (typeof window === "undefined") return [];
  try {
    const value: unknown = JSON.parse(localStorage.getItem(LOCAL_FILES_KEY) || "[]");
    return Array.isArray(value) ? value.filter((file): file is LocalFile =>
      !!file && typeof file === "object" && typeof file.id === "string" &&
      typeof file.displayName === "string" && typeof file.notes === "string" &&
      typeof file.favorite === "boolean" && typeof file.createdAt === "string",
    ) : [];
  } catch {
    return [];
  }
}

function writeFiles(files: LocalFile[]) {
  try {
    localStorage.setItem(LOCAL_FILES_KEY, JSON.stringify(files));
  } catch {
    const message = "This browser could not save your file history. Check its storage settings or free some space.";
    toast.error(message);
    throw new Error(message);
  }
  window.dispatchEvent(new Event(changeEvent));
}

export function getLocalFile(id: string) {
  if (/^[a-f0-9]{40}$/i.test(id)) id = id.toLowerCase();
  return listLocalFiles().find((file) => file.id === id || file.shareId === id);
}

export function putLocalFile(file: LocalFile): LocalFile {
  const files = listLocalFiles();
  const index = files.findIndex((entry) => entry.id === file.id);
  if (index < 0) files.unshift(file);
  else files[index] = file;
  writeFiles(files);
  return file;
}

export function createLocalFile(values: Partial<LocalFile> = {}): LocalFile {
  return putLocalFile({
    id: crypto.randomUUID(),
    displayName: "",
    notes: "",
    favorite: false,
    createdAt: new Date().toISOString(),
    direction: "seed",
    ...values,
  });
}

export function removeLocalFile(id: string) {
  writeFiles(listLocalFiles().filter((file) => file.id !== id));
}

export function rememberShare(share: PublicShare, direction: LocalFile["direction"] = "receive", draftId?: string): LocalFile {
  const files = listLocalFiles();
  const existing = files.find((file) => file.shareId === share.id);
  const draft = draftId ? files.find((file) => file.id === draftId) : undefined;
  const file = existing || draft || createLocalFile({ direction });
  const result = {
    ...file,
    shareId: share.id,
    displayName: file.displayName || share.filename,
    share,
    status: undefined,
  };
  // Seeding an already-known torrent reuses its personal entry.
  if (existing && draft && existing.id !== draft.id) removeLocalFile(draft.id);
  return putLocalFile(result);
}

export function useLocalFiles() {
  const [files, setFiles] = useState<LocalFile[]>([]);
  useEffect(() => {
    const refresh = () => setFiles(listLocalFiles());
    refresh();
    window.addEventListener(changeEvent, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(changeEvent, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);
  return files;
}

export function useLocalFile(id: string) {
  if (/^[a-f0-9]{40}$/i.test(id)) id = id.toLowerCase();
  const files = useLocalFiles();
  const file = files.find((entry) => entry.id === id || entry.shareId === id);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    const local = getLocalFile(id);
    const shareId = local?.shareId || (/^[a-f0-9]{40}$/i.test(id) ? id.toLowerCase() : undefined);
    if (!shareId) {
      setLoading(false);
      return;
    }
    // Only a mounted, explicitly opened detail page renews the share. Route
    // preloads and sidebar refreshes never call this access action.
    const body = new FormData();
    body.set("intent", "access");
    body.set("shareId", shareId);
    void fetch("/api/files", { method: "POST", body }).then(async (response) => {
      const result: { share?: PublicShare | null } = await response.json();
      if (cancelled) return;
      if (response.ok && result.share) rememberShare(result.share, local?.direction, local?.id);
      else if (response.status === 404 || response.status === 410) {
        if (local) putLocalFile({ ...(getLocalFile(local.id) || local), status: "expired" });
        else setError("This share has expired or could not be found.");
      } else setError("Could not load this share. Please try again.");
    }).catch(() => {
      if (!cancelled) setError("Could not load this share. Please try again.");
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [id]);
  return { file, loading, error };
}
