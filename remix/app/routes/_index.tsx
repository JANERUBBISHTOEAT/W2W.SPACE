import { GoogleLogin, GoogleOAuthProvider } from "@react-oauth/google";
import type { CredentialResponse } from "@react-oauth/google";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useFetcher, useLoaderData, useLocation, useNavigate } from "@remix-run/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { getFileByToken, mergeFiles } from "~/utils/data.server";
import { mergeTexts } from "~/utils/text.server";
import { prettyBytes } from "~/utils/functions";
import HashMap from "~/utils/hashmap.server";
import { verifyGoogleCredential } from "~/utils/google-auth.server";
import type { SessionIdentity } from "~/utils/session.server";
import {
  commitSession,
  destroySession,
  getSession,
  getUserSession,
  getVisitorSession,
} from "~/utils/session.server";
import { loadTorrentClient } from "~/utils/webtorrent.client";
import type { BrowserTorrentFile } from "~/utils/webtorrent.client";

interface HomeActionData {
  user?: SessionIdentity | null;
  error?: string;
  intent?: "acquireMagnet" | "acquireToken";
  type?: "text" | "file" | null;
  textId?: string;
  fileId?: string;
  token?: string;
  magnet?: string | null;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await getUserSession(request);
  return json({ googleClientId: process.env.GOOGLE_CLIENT_ID || "", user: user ?? null });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "OAuthCallback") {
    // Prevent login CSRF: a cross-site form must not sign another browser in.
    // Compare hosts because HTTPS may terminate at the deployment proxy while
    // Remix receives HTTP internally. Never accept an absent/opaque Origin.
    const origin = request.headers.get("Origin");
    let sameHost = false;
    try {
      if (origin) {
        const originUrl = new URL(origin);
        sameHost = (originUrl.protocol === "http:" || originUrl.protocol === "https:") && originUrl.host === new URL(request.url).host;
      }
    } catch {
      // Invalid Origin is rejected below.
    }
    if (!sameHost || request.headers.get("Sec-Fetch-Site") === "cross-site") {
      return json({ error: "Login must originate from this site" }, { status: 403 });
    }
    const audience = process.env.GOOGLE_CLIENT_ID;
    if (!audience) {
      return json({ error: "Google login is not configured" }, { status: 503 });
    }
    const credential = formData.get("credential");
    if (typeof credential !== "string" || !credential) {
      return json({ error: "Google credential is required" }, { status: 400 });
    }

    let identity: SessionIdentity;
    try {
      identity = await verifyGoogleCredential(credential, audience);
    } catch {
      return json({ error: "Google login could not be verified" }, { status: 401 });
    }

    const session = await getSession(request);
    const visitor = await getVisitorSession(request);
    if (visitor?.sub) {
      await Promise.all([mergeFiles(identity.sub, visitor.sub), mergeTexts(identity.sub, visitor.sub)]);
      session.unset("visitor");
    }
    session.set("user", identity);
    return json({ user: identity }, { headers: { "Set-Cookie": await commitSession(session) } });
  }

  if (intent === "Logout") {
    const session = await getSession(request);
    return json({ user: null }, { headers: { "Set-Cookie": await destroySession(session) } });
  }

  if (intent === "acquireMagnet") {
    const token = formData.get("token");
    if (typeof token !== "string" || !token) {
      return json({ error: "Token is required" }, { status: 400 });
    }
    const result = await HashMap.getBoth(token);
    if (result.status === "deleted") {
      return json({ intent, type: null, magnet: null });
    }
    if (result.textId) {
      return json({ intent, textId: result.textId, magnet: null, type: "text" });
    }
    if (result.type === "file") {
      const file = await getFileByToken(token);
      if (file?.magnet) return json({ intent, fileId: file.id, magnet: file.magnet, type: "file" });
    }
    return json({ intent, magnet: null, type: null });
  }

  return json({ error: "Unknown intent" }, { status: 400 });
};

async function downloadTorrentFile(file: BrowserTorrentFile) {
  const blob = await file.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.textContent = `Download file ${file.name}`;
  link.download = file.name;
  const container = document.createElement("div");
  container.appendChild(link);
  document.getElementById("fileList")?.appendChild(container);
  link.click();
}

export default function Index() {
  const { googleClientId, user: initialUser } = useLoaderData<typeof loader>();
  const location = useLocation();
  const navigate = useNavigate();
  const { submit, data } = useFetcher<HomeActionData>();
  const restoreFetcher = useFetcher<{ success?: boolean; url?: string; error?: string }>();
  const { submit: restore, state: restoreState, data: restoreData } = restoreFetcher;
  const restoreHandledRef = useRef(false);
  const [user, setUser] = useState<SessionIdentity | null>(initialUser);
  const handledDataRef = useRef<HomeActionData>();
  const shownMessageKeyRef = useRef<string>();
  const handledTokenRef = useRef<string>();

  const handleDownload = useCallback((value: string, type: "token" | "magnet") => {
    if (!value) return;
    submit(
      type === "token"
        ? { intent: "acquireMagnet", token: value }
        : { intent: "acquireToken", magnet: value },
      { method: "POST", action: "/api/new/token" },
    );
  }, [submit]);

  useEffect(() => {
    const handlePaste = (event: ClipboardEvent) => {
      const items = event.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.kind === "file") {
          const file = item.getAsFile();
          if (!file) continue;
          const previousUrl = localStorage.getItem("fileURL");
          if (previousUrl) URL.revokeObjectURL(previousUrl);
          localStorage.setItem("fileURL", URL.createObjectURL(file));
          submit({ fileName: file.name, mimeType: file.type }, { method: "POST", action: "/api/new/file" });
          return;
        }
        if (item.kind === "string") {
          item.getAsString((raw) => {
            const text = raw.trim();
            const type = /^\d+$/.test(text) ? "token" : text.startsWith("magnet:?") ? "magnet" : null;
            if (!type) return;
            const input = document.querySelector<HTMLInputElement>(`input[name="${type}"]`);
            if (input) input.value = text;
            handleDownload(text, type);
          });
          return;
        }
      }
    };
    document.addEventListener("paste", handlePaste);
    return () => document.removeEventListener("paste", handlePaste);
  }, [handleDownload, submit]);

  useEffect(() => {
    const token = new URLSearchParams(location.search).get("token");
    if (!token || handledTokenRef.current === token) return;
    handledTokenRef.current = token;
    const input = document.getElementById("tokenInput") as HTMLInputElement | null;
    if (input) input.value = token;
    handleDownload(token, "token");
  }, [location.search, handleDownload]);

  useEffect(() => {
    if (restoreState === "submitting" || restoreState === "loading") {
      restoreHandledRef.current = false;
      return;
    }
    if (!restoreData || restoreHandledRef.current) return;
    restoreHandledRef.current = true;
    if (restoreData.success && restoreData.url) {
      toast.success("Restored");
      navigate(restoreData.url);
    } else if (restoreData.error) toast.error(restoreData.error);
  }, [restoreData, restoreState, navigate]);

  useEffect(() => {
    const search = new URLSearchParams(location.search);
    const message = search.get("message");
    const undoId = search.get("undoId");
    const undoType = search.get("undoType");
    const key = `${location.pathname}:${location.search}`;
    if (!message || shownMessageKeyRef.current === key) return;
    shownMessageKeyRef.current = key;
    if (message === "Deleted" && undoId && (undoType === "file" || undoType === "text")) {
      toast.success("Deleted", {
        action: {
          label: "Undo",
          onClick: () => restore({ undoId, undoType }, { method: "POST", action: "/api/restore" }),
        },
      });
    } else toast.info(message);
    window.history.replaceState({}, "", location.pathname);
  }, [location, restore]);

  useEffect(() => {
    if (!data || handledDataRef.current === data) return;
    if (data.error) {
      handledDataRef.current = data;
      toast.error(data.error);
      return;
    }
    if ("user" in data) {
      handledDataRef.current = data;
      setUser(data.user ?? null);
      return;
    }
    if (data.intent !== "acquireToken" && data.intent !== "acquireMagnet") return;
    if (data.type === "text" && data.textId) {
      handledDataRef.current = data;
      navigate(`/texts/${data.textId}`);
      return;
    }

    const tokenInput = document.getElementById("tokenInput") as HTMLInputElement | null;
    if (!data.magnet || (data.intent === "acquireToken" && !data.token)) {
      handledDataRef.current = data;
      tokenInput?.classList.add("wrong-input");
      toast.error("No shared file was found for this token or link.");
      return;
    }
    const magnet = data.magnet;
    let cancelled = false;
    void loadTorrentClient().then((client) => {
      if (cancelled || handledDataRef.current === data) return;
      handledDataRef.current = data;
      tokenInput?.classList.remove("wrong-input");
      tokenInput?.classList.add("correct-input");
      const existing = client.torrents.find((torrent) => torrent.magnetURI === magnet);
      const torrent = existing ?? client.add(magnet);
      const toastId = `download-${data.token || torrent.infoHash || magnet}`;
      toast.loading("Downloading 0%", { id: toastId });
      const onReady = () => {
        if (data.fileId) {
          submit({
            intent: "updateFile",
            fileid: data.fileId,
            magnet: torrent.magnetURI,
            filename: torrent.name,
            filesize: String(torrent.length),
            filetype: torrent.files[0]?.type || "",
          }, { method: "POST", action: "/api/files" });
        }
      };
      const onDone = () => {
        toast.dismiss(toastId);
        toast.success("Download finished! Your file is ready for use 🎉");
        if (tokenInput) {
          tokenInput.value = "";
          tokenInput.className = "";
        }
        for (const file of torrent.files) {
          void downloadTorrentFile(file).catch(() => toast.error("Could not save the downloaded file."));
        }
      };
      if (torrent.ready) onReady();
      else torrent.on("ready", onReady);
      if (torrent.done) onDone();
      else torrent.on("done", onDone);
      if (!existing) {
        torrent.on("download", () => {
          toast.loading(`Downloading ${(torrent.progress * 100).toFixed(1)}%`, {
            id: toastId,
            description: `${prettyBytes(torrent.downloadSpeed)}/s · ${torrent.numPeers} peers`,
          });
        });
        torrent.on("error", () => {
          toast.dismiss(toastId);
          toast.error("The transfer failed. Check that the sender is still online.");
        });
      }
    }).catch(() => toast.error("Could not initialize file sharing. Please try again."));
    return () => { cancelled = true; };
  }, [data, navigate, submit]);

  const handleLogin = (response: CredentialResponse) => {
    if (!response.credential) {
      toast.error("Google did not return a login credential.");
      return;
    }
    submit({ intent: "OAuthCallback", credential: response.credential }, { method: "POST", action: "." });
  };

  return (
    <div id="index-page">
      <div>
        <p>Receive using your token:</p>
        <input
          type="text"
          name="token"
          aria-label="Share token"
          title="💡Try pasting onto page without clicking"
          onKeyDown={(event) => {
            event.currentTarget.className = "";
            if (event.key === "Enter") handleDownload(event.currentTarget.value.trim(), "token");
          }}
          id="tokenInput"
        />
      </div>
      <div id="fileList"></div>
      <div className="google-login-container">
        {user ? (
          <div>
            <p>You are logged in as {user.name || "visitor"}</p>
            <button onClick={() => submit({ intent: "Logout" }, { method: "POST", action: "." })}>Logout</button>
          </div>
        ) : googleClientId ? (
          <GoogleOAuthProvider clientId={googleClientId}>
            <div className="login-button">
              <p>log in to sync file history:</p>
              <GoogleLogin onSuccess={handleLogin} onError={() => toast.error("Google login failed.")} />
            </div>
          </GoogleOAuthProvider>
        ) : null}
      </div>
      <div className="footer">
        <a className="visitor-badge" href="https://visitorbadge.io/status?path=https%3A%2F%2Fw2w.space%2F">
          <img src="https://api.visitorbadge.io/api/combined?path=https%3A%2F%2Fw2w.space%2F&countColor=%2337d67a&style=plastic&labelStyle=none" alt="Visitor badge" />
        </a>
        <a className="github-link" href="https://github.com/JANERUBBISHTOEAT/W2W.SPACE#why-w2w">| Why W2W?</a>
        <a className="github-link" href="https://github.com/JANERUBBISHTOEAT/W2W.SPACE">| View on GitHub</a>
      </div>
    </div>
  );
}
