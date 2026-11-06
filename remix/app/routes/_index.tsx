import { GoogleOAuthProvider } from "@react-oauth/google";
import type { CredentialResponse } from "@react-oauth/google";
import {
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
  data,
  useFetcher,
  useLoaderData,
  useLocation,
  useNavigate,
} from "react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { resolveToken } from "~/utils/share.server";
import { createLocalFile, getLocalFile, rememberShare } from "~/utils/files.local";
import { normalizeInfoHash } from "~/utils/infohash";
import type { PublicShare } from "~/utils/files.local";
import { verifyGoogleCredential } from "~/utils/google-auth.server";
import { consumeGoogleLoginChallenge, isGoogleLoginNonce } from "~/utils/google-login-challenge.server";
import { isSameSiteRequest } from "~/utils/request-origin.server";
import GoogleLoginWithNonce from "~/components/GoogleLoginWithNonce";
import type { SessionIdentity } from "~/utils/session.server";
import {
  commitSession,
  destroySession,
  getSession,
  getUserSession,
} from "~/utils/session.server";
import { receiveFile } from "~/utils/webtorrent.client";
import { useTransfers } from "~/components/TransferStatus";

interface HomeActionData {
  user?: SessionIdentity | null;
  error?: string;
  intent?: "acquireMagnet" | "acquireToken" | "OAuthCallback";
  type?: "text" | "file" | null;
  textId?: string;
  fileId?: string;
  shareId?: string;
  share?: PublicShare;
  token?: string;
  magnet?: string | null;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await getUserSession(request);
  return data({ googleClientId: process.env.GOOGLE_CLIENT_ID || "", user: user ?? null });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "OAuthCallback") {
    const failure = (error: string, status: number) => data({ error, intent: "OAuthCallback" as const }, { status });
    if (!isSameSiteRequest(request)) {
      return failure("Login must originate from this site", 403);
    }
    const audience = process.env.GOOGLE_CLIENT_ID;
    if (!audience) {
      return failure("Google login is not configured", 503);
    }
    const credential = formData.get("credential");
    if (typeof credential !== "string" || !credential) {
      return failure("Google credential is required", 400);
    }
    const nonce = formData.get("nonce");
    if (!isGoogleLoginNonce(nonce)) return failure("Please restart Google login", 401);

    let identity: SessionIdentity;
    try {
      identity = await verifyGoogleCredential(credential, audience, nonce);
    } catch {
      return failure("Google login could not be verified", 401);
    }
    try {
      if (!await consumeGoogleLoginChallenge(request, nonce)) {
        return failure("Google login expired or was already used. Please try again.", 401);
      }
    } catch {
      // A timed-out consume might already have executed. Never restore a nonce
      // or merge history on an uncertain outcome; start a fresh challenge.
      return failure("Google login is temporarily unavailable. Please try again.", 503);
    }

    const session = await getSession(request);
    session.unset("visitor");
    session.set("user", identity);
    return data({ user: identity }, { headers: { "Set-Cookie": await commitSession(session) } });
  }

  if (intent === "Logout") {
    const session = await getSession(request);
    return data({ user: null }, { headers: { "Set-Cookie": await destroySession(session) } });
  }

  if (intent === "acquireMagnet") {
    const token = formData.get("token");
    if (typeof token !== "string" || !token) {
      return data({ error: "Token is required" }, { status: 400 });
    }
    const result = await resolveToken(token, true);
    if (result?.type === "text") {
      return data({ intent, textId: result.share.id, magnet: null, type: "text" });
    }
    if (result?.type === "file") {
      return data({ intent, share: result.share, shareId: result.share.id, fileId: result.share.id, token: result.share.token, magnet: result.share.magnet, type: "file" });
    }
    return data({ intent, magnet: null, type: null });
  }

  return data({ error: "Unknown intent" }, { status: 400 });
};

export default function Index() {
  const { googleClientId, user: initialUser } = useLoaderData<typeof loader>();
  const location = useLocation();
  const navigate = useNavigate();
  const { submit, data } = useFetcher<HomeActionData>();
  const [lookupPending, setLookupPending] = useState(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const transfers = useTransfers();
  const [tokenValue, setTokenValue] = useState("");
  const [tokenStatus, setTokenStatus] = useState("");
  const [tokenError, setTokenError] = useState(false);
  const inputValueRef = useRef("");
  const requestedRef = useRef<{ value: string; type: "token" | "magnet"; controller: AbortController }>();
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const restoreFetcher = useFetcher<{ success?: boolean; url?: string; error?: string }>();
  const { submit: restore, state: restoreState, data: restoreData } = restoreFetcher;
  const restoreHandledRef = useRef(false);
  const [user, setUser] = useState<SessionIdentity | null>(initialUser);
  const [googleLoginRetry, setGoogleLoginRetry] = useState(0);
  const handledDataRef = useRef<HomeActionData>();
  const shownMessageKeyRef = useRef<string>();
  const handledTokenRef = useRef<string>();

  const handleDownload = useCallback((raw: string, type: "token" | "magnet") => {
    const value = raw.trim();
    if (!value) return;
    clearTimeout(debounceRef.current);
    if (type === "token" && !/^\d{6}$/.test(value)) {
      setTokenError(true);
      setTokenStatus("Use the six-digit token from the sender.");
      return;
    }
    if (requestedRef.current?.value === value && requestedRef.current.type === type) return;
    requestedRef.current?.controller.abort();
    const request = { value, type, controller: new AbortController() };
    requestedRef.current = request;
    setTokenError(false);
    setLookupPending(true);
    setTokenStatus(type === "token" ? "Finding your share…" : "Connecting to peers…");
    const current = () => requestedRef.current === request &&
      (type === "magnet" || inputValueRef.current.trim() === value);
    const status = (message: string, error = false) => {
      if (!mountedRef.current || !current()) return;
      setTokenStatus(message);
      setTokenError(error);
    };
    // Accepted receives outlive this view. Editing the token supersedes only a
    // pending lookup; navigating to another page never cancels a transfer.
    void (async () => {
      if (type === "magnet") {
        const hash = new URLSearchParams(value.slice(value.indexOf("?") + 1)).getAll("xt")
          .find((part) => /^urn:btih:/i.test(part))?.slice(9);
        const previousFile = hash ? getLocalFile(normalizeInfoHash(hash)) : undefined;
        await receiveFile(value, (torrent) => {
          // Publish only once real torrent metadata is available. An infoHash-
          // only magnet must not freeze blank metadata into an immutable share.
          const body = new URLSearchParams({
            intent: "acquireToken", magnet: torrent.magnetURI,
            filename: torrent.name, filesize: String(torrent.length),
            filetype: torrent.files[0]?.type || "",
          });
          void fetch("/api/new/token", { method: "POST", body, signal: AbortSignal.timeout(30000) })
            .then(async (response) => {
              const result: HomeActionData = await response.json();
              if (!response.ok || !result.share) throw new Error(result.error || "Could not save this share");
              // Removing a known personal record while peers are unavailable
              // must not be undone by delayed torrent metadata.
              if (!previousFile || getLocalFile(previousFile.id)) rememberShare(result.share, "receive");
            }).catch(() => toast.error("The transfer continues, but its share could not be saved. Paste the magnet again to retry."));
        });
        return;
      }
      const response = await fetch("/api/new/token", {
        method: "POST", body: new URLSearchParams({ intent: "acquireMagnet", token: value }),
        signal: AbortSignal.any([request.controller.signal, AbortSignal.timeout(30000)]),
      });
      const result: HomeActionData = await response.json();
      if (!current()) return;
      if (!response.ok || result.error) throw new Error(result.error || "Could not find this share. Try again.");
      if (result.type === "text" && result.textId) {
        if (mountedRef.current) navigate(`/texts/${result.textId}`);
        return;
      }
      if (!result.magnet || !result.share) {
        status("No share found. Check the token and try again.", true);
        return;
      }
      status("Share found. Connecting to peers…");
      try { rememberShare(result.share, "receive"); } catch { /* Storage failure must not stop an accepted download. */ }
      await receiveFile(result.magnet);
    })().catch((error: unknown) => {
      if (!current()) return;
      const message = error instanceof Error ? error.message : "Could not start file sharing. Try again.";
      status(message, true);
      if (!mountedRef.current) toast.error(message);
    }).finally(() => {
      if (requestedRef.current !== request) return;
      requestedRef.current = undefined;
      if (mountedRef.current) setLookupPending(false);
    });
  }, [navigate]);

  const changeToken = (value: string) => {
    inputValueRef.current = value;
    setTokenValue(value);
    const invalid = Boolean(value.trim()) && !/^\d{1,6}$/.test(value.trim());
    setTokenError(invalid);
    setTokenStatus(invalid ? "Use the six-digit token from the sender." : "");
    requestedRef.current?.controller.abort();
    requestedRef.current = undefined;
    setLookupPending(false);
    clearTimeout(debounceRef.current);
    if (/^\d{6}$/.test(value.trim())) {
      debounceRef.current = setTimeout(() => handleDownload(value, "token"), 600);
    }
  };
  useEffect(() => () => clearTimeout(debounceRef.current), []);

  useEffect(() => {
    const handlePaste = (event: ClipboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && (target.closest("textarea, [contenteditable=true]") || (target instanceof HTMLInputElement && target.name !== "token"))) return;
      const items = event.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.kind === "file") {
          const file = item.getAsFile();
          if (!file) continue;
          const previousUrl = localStorage.getItem("fileURL");
          if (previousUrl) URL.revokeObjectURL(previousUrl);
          localStorage.setItem("fileURL", URL.createObjectURL(file));
          const draft = createLocalFile({ displayName: file.name });
          const query = new URLSearchParams({ pasted: "true", fileName: file.name, mimeType: file.type });
          navigate(`/files/${draft.id}/edit?${query}`);
          return;
        }
        if (item.kind === "string") {
          item.getAsString((raw) => {
            const text = raw.trim();
            const type = /^\d+$/.test(text) ? "token" : text.startsWith("magnet:?") ? "magnet" : null;
            if (!type) return;
            if (type === "token") {
              inputValueRef.current = text;
              setTokenValue(text);
            }
            handleDownload(text, type);
          });
          return;
        }
      }
    };
    document.addEventListener("paste", handlePaste);
    return () => document.removeEventListener("paste", handlePaste);
  }, [handleDownload, navigate]);

  useEffect(() => {
    const token = new URLSearchParams(location.search).get("token");
    if (!token || handledTokenRef.current === token) return;
    handledTokenRef.current = token;
    inputValueRef.current = token;
    setTokenValue(token);
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
    } else if (message === "Deleted") {
      toast.success("Deleted");
    } else toast.info(message);
    window.history.replaceState({}, "", location.pathname);
  }, [location, restore]);

  useEffect(() => {
    if (!data || handledDataRef.current === data) return;
    if (data.error) {
      handledDataRef.current = data;
      toast.error(data.error);
      if (data.intent === "OAuthCallback") setGoogleLoginRetry((version) => version + 1);
      return;
    }
    if ("user" in data) {
      handledDataRef.current = data;
      setUser(data.user ?? null);
      return;
    }
  }, [data]);


  const handleLogin = (response: CredentialResponse, nonce: string) => {
    if (!response.credential) {
      toast.error("Google did not return a login credential.");
      return;
    }
    submit({ intent: "OAuthCallback", credential: response.credential, nonce }, { method: "POST", action: "." });
  };

  return (
    <div id="index-page">
      <div>
        <input
          type="text"
          name="token"
          aria-label="Share token"
          title="Paste a token, or type all 6 digits to start"
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          value={tokenValue}
          onChange={(event) => changeToken(event.target.value)}
          onPaste={(event) => {
            const text = event.clipboardData.getData("text/plain").trim();
            const type = /^\d+$/.test(text) ? "token" : text.startsWith("magnet:?") ? "magnet" : null;
            if (!type) return;
            event.preventDefault();
            event.stopPropagation();
            if (type === "token") {
              inputValueRef.current = text;
              setTokenValue(text);
            }
            handleDownload(text, type);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              handleDownload(event.currentTarget.value, "token");
            }
          }}
          aria-describedby={tokenStatus ? "token-input-hint" : undefined}
          aria-invalid={tokenError}
          aria-busy={lookupPending}
          className={tokenError ? "wrong-input" : ""}
          id="tokenInput"
        />
        {tokenStatus && <span id="token-input-hint" className="token-input-hint" data-error={tokenError} role="status">{tokenStatus}</span>}
      </div>
      <div id="fileList">
        {transfers.files.map((file) => <div key={file.url}><a href={file.url} download={file.name}>Download file{file.name}</a></div>)}
      </div>
      <div className="google-login-container">
        {user ? (
          <div>
            <p>You are logged in as {user.name || "visitor"}</p>
            <button onClick={() => submit({ intent: "Logout" }, { method: "POST", action: "." })}>Logout</button>
          </div>
        ) : googleClientId ? (
          <GoogleOAuthProvider clientId={googleClientId}>
            <div className="login-button">
              <p>log in with your Google account:</p>
              <GoogleLoginWithNonce onSuccess={handleLogin} retryVersion={googleLoginRetry} />
            </div>
          </GoogleOAuthProvider>
        ) : null}
      </div>
      <div className="footer">
        <a className="visitor-badge" href="https://visitorbadge.io/status?path=https%3A%2F%2Fw2w.space%2F">
          <img src="https://api.visitorbadge.io/api/combined?path=https%3A%2F%2Fw2w.space%2F&countColor=%2337d67a&style=plastic&labelStyle=none" alt="Visitor badge" />
        </a>
        <a className="github-link" href="https://janerubbishtoeat.github.io/W2W.SPACE/#why-w2w">| Why W2W?</a>
        <a className="github-link" href="https://github.com/JANERUBBISHTOEAT/W2W.SPACE">| View on GitHub</a>
      </div>
    </div>
  );
}
