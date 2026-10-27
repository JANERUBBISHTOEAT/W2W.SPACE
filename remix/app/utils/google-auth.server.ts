import { OAuth2Client } from "google-auth-library";
import type { SessionIdentity } from "./session.server";

const googleAuth = new OAuth2Client();

export async function verifyGoogleCredential(
  credential: string,
  audience: string,
): Promise<SessionIdentity> {
  // Reject malformed/unsigned input before the library fetches certificates.
  // Decoding the header is only an early rejection check, never authentication.
  const parts = credential.split(".");
  if (credential.length > 16384 || parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) {
    throw new Error("Invalid Google credential format");
  }
  const header: unknown = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  if (!header || typeof header !== "object" || !("alg" in header) || header.alg !== "RS256" || !("kid" in header) || typeof header.kid !== "string" || !header.kid) {
    throw new Error("Invalid Google credential header");
  }

  // Authoritatively validate the Google signature, issuer, expiry and audience.
  const ticket = await googleAuth.verifyIdToken({ idToken: credential, audience });
  const payload = ticket.getPayload();
  if (!payload?.sub) throw new Error("Missing Google subject");
  return {
    sub: payload.sub,
    name: payload.name,
    email: payload.email,
    picture: payload.picture,
  };
}
