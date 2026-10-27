import { randomBytes } from "node:crypto";
import { config } from "dotenv";
import {
  createCookieSessionStorage,
  type Session,
} from "react-router";

export interface SessionIdentity {
  sub: string;
  name?: string;
  email?: string;
  picture?: string;
}

interface AppSessionData {
  user?: SessionIdentity;
  visitor?: SessionIdentity;
}

config();
const configuredSecret = process.env.SESSION_SECRET;
if (process.env.NODE_ENV === "production" && (!configuredSecret || configuredSecret.length < 32)) {
  throw new Error("SESSION_SECRET must contain at least 32 characters in production");
}
// Local development sessions expire on restart unless a secret is configured.
const sessionSecret = configuredSecret || randomBytes(32).toString("hex");

export const sessionStorage = createCookieSessionStorage<AppSessionData>({
  cookie: {
    name: "session",
    secure: process.env.NODE_ENV === "production",
    secrets: [sessionSecret],
    sameSite: "lax",
    path: "/",
    httpOnly: true,
  },
});

export async function getSession(request: Request) {
  return sessionStorage.getSession(request.headers.get("Cookie"));
}

export async function commitSession(session: Session<AppSessionData>) {
  return sessionStorage.commitSession(session);
}

export async function destroySession(session: Session<AppSessionData>) {
  return sessionStorage.destroySession(session);
}

export async function getUserSession(
  request: Request
): Promise<SessionIdentity | undefined> {
  const session = await getSession(request);
  return session.get("user");
}
export async function getVisitorSession(
  request: Request
): Promise<SessionIdentity | undefined> {
  const session = await getSession(request);
  return session.get("visitor");
}

export async function requireSessionIdentity(request: Request): Promise<SessionIdentity> {
  const session = await getSession(request);
  const identity = session.get("user") || session.get("visitor");
  if (!identity?.sub) {
    throw new Response("Visit the home page to start a session", { status: 401 });
  }
  return identity;
}
