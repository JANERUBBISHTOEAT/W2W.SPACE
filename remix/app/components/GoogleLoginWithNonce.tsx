import { GoogleLogin } from "@react-oauth/google";
import type { CredentialResponse } from "@react-oauth/google";
import { useCallback, useEffect } from "react";
import { useFetcher } from "react-router";
import { toast } from "sonner";

interface LoginChallenge {
  nonce?: string;
  expiresAt?: number;
  expiresIn?: number;
  error?: string;
}

export default function GoogleLoginWithNonce({ onSuccess, retryVersion }: {
  onSuccess: (response: CredentialResponse, nonce: string) => void;
  retryVersion: number;
}) {
  const { submit, data: challenge, state } = useFetcher<LoginChallenge>();
  const refresh = useCallback(() => {
    submit({}, { method: "POST", action: "/api/auth/google/challenge" });
  }, [submit]);

  // Root has established the signed visitor cookie before this independent
  // request. It must not race root's Set-Cookie from a parallel index loader.
  useEffect(refresh, [refresh, retryVersion]);
  useEffect(() => {
    if (challenge?.error) toast.error(challenge.error);
  }, [challenge]);
  useEffect(() => {
    if (!challenge?.nonce || !challenge.expiresIn) return;
    // Use a relative lifetime: client clock skew must not cause a tight retry
    // loop or delay refresh beyond the server's Redis TTL. Leave transit margin.
    const timer = window.setTimeout(refresh, Math.max(1000, challenge.expiresIn * 1000 - 30000));
    return () => window.clearTimeout(timer);
  }, [challenge, refresh]);

  if (challenge?.error) {
    return <button type="button" disabled={state !== "idle"} onClick={refresh}>Retry Google login</button>;
  }
  if (!challenge?.nonce) return null;
  const nonce = challenge.nonce;
  return <GoogleLogin
    // This library's initialization effect does not track nonce changes.
    // Remount the button to install a refreshed OIDC nonce, keeping Provider.
    key={nonce}
    nonce={nonce}
    onSuccess={(response) => onSuccess(response, nonce)}
    onError={() => { toast.error("Google login failed."); refresh(); }}
  />;
}
