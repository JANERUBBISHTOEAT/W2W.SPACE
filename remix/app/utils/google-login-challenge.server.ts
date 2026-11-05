import { createHash, randomBytes } from "node:crypto";
import { config } from "dotenv";
import Redis from "ioredis";
import { getSession } from "./session.server";

config();
const redis = new Redis({
  host: process.env.REDIS_HOST || "localhost",
  port: parseInt(process.env.REDIS_PORT || "6379", 10),
  connectTimeout: 2000,
  commandTimeout: 2000,
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
});
// Commands fail closed in the route; never log a nonce, credential or cookie.
redis.on("error", () => {});

const CHALLENGE_TTL_SECONDS = 600;
const key = (nonce: string) => `google-login:nonce:${nonce}`;

export function isGoogleLoginNonce(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

async function sessionBinding(request: Request): Promise<string | null> {
  const session = await getSession(request);
  const user = session.get("user");
  const visitor = session.get("visitor");
  const identity = user || visitor;
  if (!identity?.sub) return null;
  return createHash("sha256")
    .update(JSON.stringify([user ? "user" : "visitor", identity.sub]))
    .digest("hex");
}

export async function createGoogleLoginChallenge(request: Request) {
  const binding = await sessionBinding(request);
  if (!binding) throw new Response("Visit the home page to start a session", { status: 401 });
  const nonce = randomBytes(32).toString("base64url");
  const result = await redis.set(key(nonce), binding, "EX", CHALLENGE_TTL_SECONDS, "NX");
  if (result !== "OK") throw new Error("Could not create login challenge");
  return { nonce, expiresAt: Date.now() + CHALLENGE_TTL_SECONDS * 1000, expiresIn: CHALLENGE_TTL_SECONDS };
}

export async function consumeGoogleLoginChallenge(request: Request, nonce: string): Promise<boolean> {
  if (!isGoogleLoginNonce(nonce)) return false;
  const binding = await sessionBinding(request);
  if (!binding) return false;
  // Compare and delete in one command: concurrent callbacks cannot both win.
  // A callback from another visitor must not consume the rightful challenge.
  const consumed = await redis.eval(
    "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
    1,
    key(nonce),
    binding,
  );
  return consumed === 1;
}
