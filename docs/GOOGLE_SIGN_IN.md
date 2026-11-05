# Google sign-in verification and replay protection

W2W uses the Google Identity Services JavaScript ID-token callback. It does not
exchange an authorization code, request access to Google APIs, or accept a
user-supplied redirect target. The server validates Google's signature, issuer,
audience, token time and subject with `google-auth-library`.

Previously, a valid, unexpired ID token for this client could be exchanged more
than once. Browser Origin and Fetch Metadata checks blocked ordinary cross-site
forms, but an attacker with a leaked token could supply an Origin header from
their own HTTP client. This finding requires possession of a valid credential;
it does not demonstrate account access without one. No real user's token or
production account was used to reproduce it.

The login button now obtains a 32-byte random nonce through the same-origin
`POST /api/auth/google/challenge` endpoint after the home page has established a
signed visitor session. Each challenge is bound to that existing session's
identity and role. It is stored in a separate Redis key with a ten-minute TTL;
independent tabs can have independent challenges. Issuing a challenge does not
write a session cookie or change a file, text or sharing record.

The nonce is passed to `GoogleLogin`, then posted alongside the credential. The
server verifies the signed token's nonce and atomically compares/consumes the
Redis challenge before merging visitor history or committing the user session.
Missing, expired, reused, cross-session or mismatched challenges fail closed.
Invalid credentials cannot consume a challenge. A Redis error or uncertain
consume result returns an unavailable response without a history merge; the
client requests a fresh challenge instead of restoring the old one.
The existing Redis application connection must allow `SET` and `EVAL`; restricted
ACLs are not modified by the application and fail closed with HTTP 503.

GoogleLogin is remounted when a challenge changes because version 0.12.2 of
`@react-oauth/google` does not reinitialize GIS when only the nonce prop changes.
The provider stays mounted. Expired challenges and rejected login callbacks
obtain a fresh challenge. Refresh uses the response's relative lifetime with a
transit margin, so client/server wall-clock skew cannot create a refresh loop.
Existing signed session cookies, verified Google
subject keys, file history migration and share links retain their formats.
An already-open sign-in page from an older release must reload to obtain the
new challenge before it can submit a Google credential.
Logging in changes the shared browser session from visitor to user, so another
tab's outstanding visitor-bound challenge must restart after that transition.

This protection does not stop someone who has already stolen the application's
signed session cookie, control the browser through XSS, or possess both an
unconsumed credential and its matching visitor session. Existing stateless
cookies are not retroactively revoked by this change. The nonce is a short-lived
challenge, not a new persistent credential. Redis TTL expiry is the only cleanup
needed, and no schema or production-data migration is required.

`tests/google-login.test.mjs` exercises the production HTTP application with
isolated Redis, ephemeral RSA-signed test tokens and a test-process-only Google
certificate provider. Production code has no test credential bypass. These tests
cover the browser/session and atomic replay boundaries but do not substitute for
a real Google popup/FedCM login on an authorized device.

Primary references:

- [Google GIS nonce](https://developers.google.com/identity/gsi/web/reference/js-reference#nonce)
- [Google ID-token verification](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token)
