import {
  type LoaderFunctionArgs,
  data,
  Form,
  useLoaderData,
  useLocation,
  useNavigate,
} from "react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { fileIconMap, FIELD_MAX_SIZE } from "~/utils/constants";
import { getLocalFile, putLocalFile, rememberShare, removeLocalFile, takePastedFile, useLocalFile } from "~/utils/files.local";
import type { LocalFile, PublicShare } from "~/utils/files.local";
import { seedFile } from "~/utils/webtorrent.client";
import type { BrowserTorrent } from "~/utils/webtorrent.client";

export const loader = async ({ params }: LoaderFunctionArgs) => {
  return data({ fileId: params.fileId || "" });
};

export default function EditFile() {
  const { fileId } = useLoaderData<typeof loader>();
  const { file, loading, error } = useLocalFile(fileId);
  if (!file) return <p>{loading ? "Loading…" : error || "This file is not in this browser."}</p>;
  return <Editor key={file.id} savedFile={file} />;
}

function Editor({ savedFile }: { savedFile: LocalFile }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState(savedFile.displayName);
  const [notes, setNotes] = useState(savedFile.notes);
  const [token, setToken] = useState<string>();
  const [torrent, setTorrent] = useState<BrowserTorrent>();
  const [error, setError] = useState<string>();
  const seedingRef = useRef(false);
  const mountedRef = useRef(true);
  const nameRef = useRef(name);
  const notesRef = useRef(notes);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const shownMessageKeyRef = useRef<string>();

  const handleSubmit = useCallback((selectedFile: File) => {
    if (seedingRef.current) return;
    const current = getLocalFile(savedFile.id);
    if (!current) return;
    const draftName = nameRef.current || selectedFile.name;
    const draftNotes = notesRef.current;
    try {
      putLocalFile({ ...current, displayName: draftName, notes: draftNotes });
    } catch { return; }
    setFile(selectedFile);
    setName(draftName);
    nameRef.current = draftName;
    seedingRef.current = true;
    const seedPromise = seedFile(selectedFile).then(async (readyTorrent) => {
      if (mountedRef.current) setTorrent(readyTorrent);
      const formData = new FormData();
      formData.set("intent", "acquireToken");
      formData.set("magnet", readyTorrent.magnetURI);
      formData.set("filename", selectedFile.name);
      formData.set("filetype", selectedFile.type);
      formData.set("filesize", String(selectedFile.size));
      const response = await fetch(`/api/${savedFile.id}/token`, { method: "POST", body: formData, signal: AbortSignal.timeout(30000) });
      const result: { token?: string; share?: PublicShare; error?: string } = await response.json();
      if (!response.ok || typeof result.token !== "string" || !result.token || !result.share) {
        throw new Error(result.error || "Could not obtain a share token");
      }
      if (mountedRef.current) setToken(result.token);
      // Publication may finish after navigation. Keep the local record,
      // but do not resurrect a draft the user explicitly removed.
      const current = getLocalFile(savedFile.id);
      if (current) {
        if (mountedRef.current && current.displayName === draftName && current.notes === draftNotes) {
          putLocalFile({ ...current, displayName: nameRef.current, notes: notesRef.current });
        }
        const localFile = rememberShare(result.share, "seed", savedFile.id);
        if (mountedRef.current) navigate(`/files/${localFile.shareId || localFile.id}/?message=File+saved`);
      }
      return result.token;
    }).finally(() => { seedingRef.current = false; });
    toast.promise(seedPromise, {
      loading: "Seeding...",
      success: (shareToken) => ({
        message: "File seeded! Your link is ready for sharing 🎉",
        action: {
          label: "Copy token",
          onClick: () => navigator.clipboard.writeText(shareToken).then(
            () => toast.success("Copied!"),
            () => toast.error("Failed to copy"),
          ),
        },
      }),
      error: (error: unknown) => error instanceof Error ? error.message : "Seeding failed",
    });
  }, [savedFile.id, navigate]);

  useEffect(() => {
    const handlePaste = (event: ClipboardEvent) => {
      const file = event.clipboardData?.files.item(0);
      if (!file) return;
      event.preventDefault();
      handleSubmit(file);
    };
    document.addEventListener("paste", handlePaste);
    return () => document.removeEventListener("paste", handlePaste);
  }, [handleSubmit]);

  useEffect(() => {
    const file = takePastedFile(savedFile.id);
    if (file) handleSubmit(file);
  }, [handleSubmit, savedFile.id]);

  useEffect(() => {
    const message = new URLSearchParams(location.search).get("message");
    const key = `${location.pathname}:${location.search}`;
    if (!message || shownMessageKeyRef.current === key) return;
    shownMessageKeyRef.current = key;
    if (message === "Existing file found") {
      toast.info(message, {
        action: {
          label: "Go to file",
          onClick: () => navigate(`/files/${savedFile.shareId || savedFile.id}`),
        },
      });
    } else {
      toast.info(message);
    }
    window.history.replaceState({}, "", location.pathname);
  }, [location, navigate, savedFile.id, savedFile.shareId]);

  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success("Copied to clipboard");
    } catch {
      toast.error("Could not copy. Please allow clipboard access and try again.");
    }
  };
  const magnet = torrent?.magnetURI || savedFile.share?.magnet || "";
  const shareToken = token || savedFile.share?.token || "";

  return (
    <Form key={savedFile.id} id="contact-form" method="post" onSubmit={(event) => {
      event.preventDefault();
      if ([name, notes].some((value) => new TextEncoder().encode(value).length > FIELD_MAX_SIZE)) {
        setError(`File details must each be at most ${FIELD_MAX_SIZE} bytes`);
        return;
      }
      putLocalFile({ ...(getLocalFile(savedFile.id) || savedFile), displayName: name, notes });
      navigate(`/files/${savedFile.shareId || savedFile.id}/?message=File+saved`);
    }}>
      {error ? <output role="alert">{error}</output> : null}
      <div
        id="dropzone"
        role="button"
        tabIndex={0}
        title="Sharing continues as you browse. Keep this tab open."
        onDrop={(event) => {
          event.preventDefault();
          const file = event.dataTransfer.files.item(0);
          if (file) handleSubmit(file);
        }}
        onDragOver={(event) => event.preventDefault()}
        onClick={(event) => {
          if (event.target !== document.getElementById("fileInput")) document.getElementById("fileInput")?.click();
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            document.getElementById("fileInput")?.click();
          }
        }}
      >
        <i className={`${file ? fileIconMap[file.type] || "fas fa-file" : "fas fa-file-upload"} fa-2x file-icon`} aria-hidden="true" />
        <div className={file ? "" : "grey"}>{file?.name || "Drag & Drop files here"}</div>
        <input type="file" name="file" title="Upload file" id="fileInput" onChange={(event) => {
          const file = event.currentTarget.files?.item(0);
          event.currentTarget.value = "";
          if (file) handleSubmit(file);
        }} />
      </div>
      <p>
        <span>Name</span>
        <input aria-label="Filename" name="fileName" value={name} onChange={(event) => { nameRef.current = event.target.value; setName(event.target.value); }} placeholder="Filename" type="text" />
        <input aria-label="Token" name="token" value={shareToken} placeholder="Token" type="text" disabled readOnly />
        <button id="copy-token" type="button" aria-label="Copy token" disabled={!shareToken} onClick={() => copy(shareToken)}>Copy</button>
      </p>
      <div className="file-link-row">
        <label htmlFor="file-magnet">File Link</label>
        <input id="file-magnet" name="_magnet" value={magnet} placeholder="magnet:?" type="text" disabled readOnly />
        <input name="magnet" value={magnet} type="hidden" readOnly />
        <button id="copy-magnet" type="button" aria-label="Copy file link" disabled={!magnet} onClick={() => copy(magnet)}>Copy</button>
      </div>
      <label>
        <span>Notes</span>
        <textarea value={notes} onChange={(event) => { notesRef.current = event.target.value; setNotes(event.target.value); }} name="notes" rows={6} />
      </label>
      <input type="hidden" name="fileType" value={file?.type ?? savedFile.share?.type ?? ""} />
      <input type="hidden" name="fileSize" value={file?.size ?? savedFile.share?.size ?? 0} />
      <p>
        <button type="submit">Save</button>
        <button type="button" onClick={() => {
          if (!savedFile.shareId) {
            removeLocalFile(savedFile.id);
            navigate("/?message=Aborted");
          } else navigate(`/files/${savedFile.shareId || savedFile.id}`);
        }}>Cancel</button>
      </p>
    </Form>
  );
}
