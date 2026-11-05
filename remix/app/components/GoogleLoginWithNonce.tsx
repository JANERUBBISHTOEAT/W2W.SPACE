import { GoogleLogin } from "@react-oauth/google";
import type { CredentialResponse } from "@react-oauth/google";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

interface LoginChallenge {
  nonce: string;
  expiresIn: number;
}

interface ChallengeState {
  challenge?: LoginChallenge;
  error?: string;
  loading: boolean;
}

const unavailable = "Google login is temporarily unavailable. Please try again.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isChallenge(value: unknown): value is LoginChallenge {
  return isRecord(value) && typeof value.nonce === "string" && /^[A-Za-z0-9_-]{43}$/.test(value.nonce) &&
    typeof value.expiresIn === "number" && Number.isInteger(value.expiresIn) && value.expiresIn > 0 && value.expiresIn <= 600;
}

export default function GoogleLoginWithNonce({ onSuccess, retryVersion }: {
  onSuccess: (response: CredentialResponse, nonce: string) => void;
  retryVersion: number;
}) {
  const [{ challenge, error, loading }, setState] = useState<ChallengeState>({ loading: true });
  const mounted = useRef(false);
  const generation = useRef(0);
  const pending = useRef<{ controller: AbortController; timeout: number }>();
  const cancelPending = useCallback(() => {
    ++generation.current;
    if (pending.current) {
      window.clearTimeout(pending.current.timeout);
      pending.current.controller.abort();
    }
    pending.current = undefined;
  }, []);
  const refresh = useCallback(() => {
    if (!mounted.current) return;
    cancelPending();
    const request = generation.current;
    const controller = new AbortController();
    // Retire the button while refreshing. Preserve an existing retry hint until
    // the replacement succeeds, without retaining an expired nonce in the UI.
    setState((previous) => ({ loading: true, error: previous.error }));
    let timedOut = false;
    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 10000);
    pending.current = { controller, timeout };
    void (async () => {
      try {
        // A login preflight must never send transport/parse failures to the
        // router's page error boundary and replace the file-receiving screen.
        const response = await fetch("/api/auth/google/challenge", {
          method: "POST",
          credentials: "same-origin",
          headers: { Accept: "application/json" },
          cache: "no-store",
          redirect: "error",
          signal: controller.signal,
        });
        const value: unknown = await response.json();
        if (request !== generation.current || !mounted.current) return;
        if (controller.signal.aborted) throw new Error("Login challenge request was aborted");
        if (!response.ok) {
          const message = isRecord(value) && typeof value.error === "string" && value.error.trim().length > 0 && value.error.length <= 240
            ? value.error : unavailable;
          setState({ error: message, loading: false });
          return;
        }
        if (!isChallenge(value)) throw new Error("Invalid login challenge response");
        setState({ challenge: value, loading: false });
      } catch {
        if (request !== generation.current || !mounted.current) return;
        setState({ error: timedOut ? "Google login took too long. Please try again." : unavailable, loading: false });
      } finally {
        window.clearTimeout(timeout);
        if (request === generation.current) pending.current = undefined;
      }
    })();
  }, [cancelPending]);

  // Root has established the signed visitor cookie before this independent
  // request. It must not race root's Set-Cookie from a parallel index loader.
  useEffect(() => {
    mounted.current = true;
    refresh();
    return () => {
      mounted.current = false;
      cancelPending();
    };
  }, [cancelPending, refresh, retryVersion]);
  useEffect(() => {
    if (!challenge?.nonce || !challenge.expiresIn) return;
    // Use a relative lifetime: client clock skew must not cause a tight retry
    // loop or delay refresh beyond the server's Redis TTL. Leave transit margin.
    const timer = window.setTimeout(refresh, Math.max(1000, challenge.expiresIn * 1000 - 30000));
    return () => window.clearTimeout(timer);
  }, [challenge, refresh]);

  if (error) {
    return <div role="alert">
      <p>{error}</p>
      <button type="button" disabled={loading} onClick={refresh}>Retry Google login</button>
    </div>;
  }
  if (!challenge?.nonce) return null;
  const nonce = challenge.nonce;
  return <GoogleLogin
    // This library's initialization effect does not track nonce changes.
    // Remount the button to install a refreshed OIDC nonce, keeping Provider.
    key={nonce}
    nonce={nonce}
    onSuccess={(response) => { if (mounted.current) onSuccess(response, nonce); }}
    onError={() => { if (mounted.current) { toast.error("Google login failed."); refresh(); } }}
  />;
}
