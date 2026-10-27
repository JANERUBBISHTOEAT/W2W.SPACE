import {
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
  data,
  redirect,
  Form,
  useActionData,
  useFetcher,
  useLoaderData,
  useLocation,
  useNavigate,
} from "react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import invariant from "tiny-invariant";
import { toast } from "sonner";
import { fileIconMap, FIELD_MAX_SIZE } from "~/utils/constants";
import { deleteFile, getFile, updateFile } from "~/utils/data.server";
import { requireSessionIdentity } from "~/utils/session.server";
import { loadTorrentClient } from "~/utils/webtorrent.client";
import type { BrowserTorrent } from "~/utils/webtorrent.client";

export const loader = async ({ params, request }: LoaderFunctionArgs) => {
  invariant(params.fileId, "Missing fileId param");
  const { sub } = await requireSessionIdentity(request);
  const file = await getFile(sub, params.fileId);
  if (!file) return redirect("/?message=Page+Not+Found");
  if (file.token) {
    const HashMap = (await import("~/utils/hashmap.server")).default;
    if ((await HashMap.getBoth(file.token)).status === "deleted") return redirect("/deleted");
  }
  const updated = await updateFile(sub, params.fileId, {
    lastAccessedAt: new Date().toISOString(),
    accessCount: (file.accessCount || 0) + 1,
  });
  const search = new URL(request.url).searchParams;
  return data({
    file: updated,
    pasted: search.get("pasted") === "true",
    fileName: search.get("fileName") || "Pasted file",
    mimeType: search.get("mimeType") || "",
  });
};

export const action = async ({ params, request }: ActionFunctionArgs) => {
  invariant(params.fileId, "Missing fileId param");
  const { sub } = await requireSessionIdentity(request);
  const file = await getFile(sub, params.fileId);
  if (!file) throw new Response("Not Found", { status: 404 });
  const formData = await request.formData();
  if (formData.get("intent") === "cancelSubmission") {
    if (!file.magnet) {
      await deleteFile(sub, params.fileId);
      return redirect("/?message=Aborted");
    }
    return data({ cancelRedirect: null });
  }

  const getString = (name: string, fallback = "") => {
    const value = formData.get(name);
    return typeof value === "string" ? value : fallback;
  };
  const filename = getString("fileName", file.filename);
  const magnet = getString("magnet", file.magnet);
  const notes = getString("notes", file.notes);
  const type = getString("fileType", file.type);
  const rawSize = getString("fileSize");
  const size = rawSize ? Number(rawSize) : (file.size ?? 0);
  if (!filename || !magnet.startsWith("magnet:?") || !Number.isSafeInteger(size) || size < 0) {
    return data({ error: "A filename, magnet link and valid file size are required" }, { status: 400 });
  }
  if ([filename, magnet, notes, type].some((value) => new TextEncoder().encode(value).length > FIELD_MAX_SIZE)) {
    return data({ error: `File details must each be at most ${FIELD_MAX_SIZE} bytes` }, { status: 400 });
  }
  const updated = await updateFile(sub, params.fileId, {
    filename,
    magnet,
    notes,
    type,
    size,
    // Share tokens are server-assigned; a form must not replace another mapping.
    token: file.token,
    lastEditedAt: new Date().toISOString(),
  }, false, true);
  if (updated.id !== params.fileId) {
    return redirect(`/files/${updated.id}/edit?message=Existing+file+found`);
  }
  return redirect(`/files/${updated.id}/?message=File+saved`);
};

export default function EditFile() {
  const { file: savedFile, pasted, fileName, mimeType } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigate = useNavigate();
  const location = useLocation();
  const [file, setFile] = useState<File | null>(null);
  const [token, setToken] = useState<string>();
  const [torrent, setTorrent] = useState<BrowserTorrent>();
  const { submit, data, state } = useFetcher<{ cancelRedirect?: string | null; error?: string }>();
  const seedingRef = useRef(false);
  const shownMessageKeyRef = useRef<string>();

  const handleSubmit = useCallback((files: FileList | null) => {
    const selectedFile = files?.[0];
    if (!selectedFile || seedingRef.current) return;
    setFile(selectedFile);
    seedingRef.current = true;
    const seedPromise = loadTorrentClient().then((client) => new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Seeding timeout")), 120000);
      const fail = (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      };
      const seeded = client.seed(selectedFile, (readyTorrent) => {
        setTorrent(readyTorrent);
        const formData = new FormData();
        formData.set("intent", "acquireToken");
        formData.set("magnet", readyTorrent.magnetURI);
        void fetch(`/api/${savedFile.id}/token`, { method: "POST", body: formData, signal: AbortSignal.timeout(30000) })
          .then(async (response) => {
            const result: { token?: string; error?: string } = await response.json();
            if (!response.ok || typeof result.token !== "string" || !result.token) {
              throw new Error(result.error || "Could not obtain a share token");
            }
            clearTimeout(timeout);
            setToken(result.token);
            submit({
              intent: "saveFile",
              fileName: selectedFile.name,
              magnet: readyTorrent.magnetURI,
              fileType: selectedFile.type,
              fileSize: String(selectedFile.size),
            }, { method: "POST", action: "." });
            resolve(result.token);
          }).catch(fail);
      });
      seeded.on("error", fail);
    })).finally(() => { seedingRef.current = false; });
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
      error: (error: unknown) => error instanceof Error && error.message === "Seeding timeout" ? "Seeding timed out" : "Seeding failed",
    });
  }, [savedFile.id, submit]);

  useEffect(() => {
    const handlePaste = (event: ClipboardEvent) => {
      const files = event.clipboardData?.files;
      if (files?.length) handleSubmit(files);
    };
    document.addEventListener("paste", handlePaste);
    return () => document.removeEventListener("paste", handlePaste);
  }, [handleSubmit]);

  useEffect(() => {
    if (!pasted) return;
    const url = localStorage.getItem("fileURL");
    if (!url) return;
    localStorage.removeItem("fileURL");
    void fetch(url).then((response) => response.blob()).then((blob) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([blob], fileName, { type: mimeType }));
      handleSubmit(transfer.files);
    }).catch(() => toast.error("Could not read the pasted file. Please select it again."))
      .finally(() => URL.revokeObjectURL(url));
  }, [pasted, fileName, mimeType, handleSubmit]);

  useEffect(() => {
    if (state !== "idle" || !data) return;
    if (data.error) toast.error(data.error);
    if (data.cancelRedirect === null) navigate(-1);
    else if (data.cancelRedirect) navigate(data.cancelRedirect);
  }, [state, data, navigate]);

  useEffect(() => {
    const message = new URLSearchParams(location.search).get("message");
    const key = `${location.pathname}:${location.search}`;
    if (!message || shownMessageKeyRef.current === key) return;
    shownMessageKeyRef.current = key;
    toast.info(message);
    window.history.replaceState({}, "", location.pathname);
  }, [location]);

  const copy = (value: string) => {
    void navigator.clipboard.writeText(value).then(
      () => toast.success("Copied to clipboard"),
      () => toast.error("Could not copy. Please copy the value manually."),
    );
  };
  const magnet = torrent?.magnetURI || savedFile.magnet || "";
  const shareToken = token || savedFile.token || "";

  return (
    <Form key={savedFile.id} id="contact-form" method="post">
      {actionData && "error" in actionData ? <p role="alert">{actionData.error}</p> : null}
      <div
        id="dropzone"
        role="button"
        tabIndex={0}
        title="💡Stay on page to keep seeding"
        onDrop={(event) => { event.preventDefault(); handleSubmit(event.dataTransfer.files); }}
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
        <input type="file" name="file" title="Upload file" id="fileInput" onChange={(event) => handleSubmit(event.target.files)} />
      </div>
      <p>
        <span>Name</span>
        <input aria-label="Filename" name="fileName" value={file?.name || savedFile.filename || ""} placeholder="Filename" readOnly />
        <input aria-label="Token" value={shareToken} placeholder="Token" readOnly />
        <button type="button" onClick={() => copy(shareToken)}>Copy</button>
      </p>
      <label>
        <span>File Link</span>
        <input name="magnet" value={magnet} placeholder="magnet:?" readOnly />
      </label>
      <button type="button" onClick={() => copy(magnet)}>Copy link</button>
      <label>
        <span>Notes</span>
        <textarea defaultValue={savedFile.notes || ""} name="notes" rows={6} />
      </label>
      <input type="hidden" name="fileType" value={file?.type ?? savedFile.type ?? ""} />
      <input type="hidden" name="fileSize" value={file?.size ?? savedFile.size ?? 0} />
      <p>
        <button type="submit">Save</button>
        <button type="button" onClick={() => submit({ intent: "cancelSubmission" }, { method: "POST", action: "." })}>Cancel</button>
      </p>
    </Form>
  );
}
