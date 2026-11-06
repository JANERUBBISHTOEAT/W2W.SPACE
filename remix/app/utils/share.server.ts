import { randomInt, randomUUID } from "node:crypto";
import { config } from "dotenv";
import Redis from "ioredis";
import { FIELD_MAX_SIZE, TEXT_MAX_SIZE } from "./constants";
import { normalizeInfoHash } from "./infohash";
export { normalizeInfoHash } from "./infohash";

config();
const redis = new Redis({
  host: process.env.REDIS_HOST || "localhost",
  port: Number(process.env.REDIS_PORT || 6379),
});

export const SHARE_TTL_SECONDS = 30 * 24 * 60 * 60;
const PREFIX = "w2w:v2:";
export type ShareKind = "file" | "text";
type SharedRecord = { id: string; token: string; lastAccessedAt: string };
export type FileShare = SharedRecord & {
  magnet: string;
  filename: string;
  size: number;
  type: string;
};
export type TextShare = SharedRecord & { content: string };
export type FileMetadata = { magnet: string; filename?: string; size?: number; type?: string };

export class ShareValidationError extends Error {}

function checkedString(value: unknown, name: string, limit = FIELD_MAX_SIZE): string {
  if (typeof value !== "string" || Buffer.byteLength(value) > limit) {
    throw new ShareValidationError(`Invalid ${name}`);
  }
  return value;
}

export function parseMagnet(value: unknown): { id: string; magnet: string; filename: string; size: number } {
  const magnet = checkedString(value, "magnet link").trim();
  let url: URL;
  try { url = new URL(magnet); } catch { throw new ShareValidationError("A valid magnet link is required"); }
  if (url.protocol !== "magnet:" || !magnet.startsWith("magnet:?")) {
    throw new ShareValidationError("A valid magnet link is required");
  }
  const hashes = url.searchParams.getAll("xt")
    .filter((topic) => /^urn:btih:/i.test(topic))
    .map((topic) => {
      try { return normalizeInfoHash(topic.slice(9)); }
      catch { throw new ShareValidationError("A valid BitTorrent infoHash is required"); }
    });
  if (!hashes.length || hashes.some((hash) => hash !== hashes[0])) {
    throw new ShareValidationError("One unambiguous BitTorrent infoHash is required");
  }
  const size = Number(url.searchParams.get("xl") || 0);
  return {
    id: hashes[0], magnet,
    filename: checkedString(url.searchParams.get("dn") || "", "filename"),
    size: Number.isSafeInteger(size) && size >= 0 ? size : 0,
  };
}

function recordKey(kind: ShareKind, id: string) { return `${PREFIX}share:${kind}:${id}`; }

// Records and aliases expire at the same Redis-clock instant. The scripts keep
// lookup, edit and renewal atomic, so a stale request cannot resurrect expiry.
const renewLua = `
local function renew(key, record)
  local now = redis.call('TIME')
  local expires = tonumber(now[1]) * 1000 + math.floor(tonumber(now[2]) / 1000) + tonumber(ARGV[1])
  record.lastAccessedAt = ARGV[2]
  local encoded = cjson.encode(record)
  redis.call('SET', key, encoded)
  redis.call('PEXPIREAT', key, expires)
  local tokenKey = ARGV[3] .. 'token:' .. record.token
  redis.call('SET', tokenKey, cjson.encode({kind=ARGV[4], id=record.id}))
  redis.call('PEXPIREAT', tokenKey, expires)
  return encoded
end
`;
const publishLua = renewLua + `
local existing = redis.call('GET', KEYS[1])
if existing then return renew(KEYS[1], cjson.decode(existing)) end
if redis.call('EXISTS', KEYS[2]) == 1 then return false end
return renew(KEYS[1], cjson.decode(ARGV[5]))
`;
const accessLua = renewLua + `
local existing = redis.call('GET', KEYS[1])
if not existing then return false end
local record = cjson.decode(existing)
if ARGV[7] ~= '' and record.token ~= ARGV[7] then return false end
if ARGV[5] == 'edit' then record.content = ARGV[6] end
return renew(KEYS[1], record)
`;
function argumentsFor(kind: ShareKind) {
  return [String(SHARE_TTL_SECONDS * 1000), new Date().toISOString(), PREFIX, kind];
}
async function publish<T extends SharedRecord>(kind: ShareKind, record: Omit<T, "token" | "lastAccessedAt">): Promise<T> {
  for (let length = 1; length <= 6; length++) {
    const minimum = length === 1 ? 0 : 10 ** (length - 1);
    const token = randomInt(minimum, 10 ** length).toString();
    const raw = await redis.eval(publishLua, 2, recordKey(kind, record.id), `${PREFIX}token:${token}`,
      ...argumentsFor(kind), JSON.stringify({ ...record, token }));
    if (typeof raw === "string") return JSON.parse(raw) as T;
  }
  throw new Error("Unable to allocate a unique sharing token");
}
async function read<T>(kind: ShareKind, id: string, touch: boolean, content?: string, expectedToken = ""): Promise<T | null> {
  if (kind === "file") {
    try { id = normalizeInfoHash(id); } catch { return null; }
  } else if (!/^[a-f\d-]{36}$/i.test(id)) return null;
  const raw = touch
    ? await redis.eval(accessLua, 1, recordKey(kind, id), ...argumentsFor(kind), content === undefined ? "access" : "edit", content ?? "", expectedToken)
    : await redis.get(recordKey(kind, id));
  return typeof raw === "string" ? JSON.parse(raw) as T : null;
}
export async function publishShare(metadata: FileMetadata): Promise<FileShare> {
  const parsed = parseMagnet(metadata.magnet);
  const size = metadata.size ?? parsed.size;
  if (!Number.isSafeInteger(size) || size < 0) throw new ShareValidationError("Invalid file size");
  return publish<FileShare>("file", {
    id: parsed.id, magnet: parsed.magnet,
    filename: checkedString(metadata.filename ?? parsed.filename, "filename"),
    type: checkedString(metadata.type ?? "", "file type"), size,
  });
}
/** Metadata inspection (sidebar refresh, preload) must never extend a share. */
export function getShare(id: string) { return read<FileShare>("file", id, false); }
export function accessShare(id: string) { return read<FileShare>("file", id, true); }
export function createTextShare(content = "# Welcome to Text Editor\n\nStart typing...") {
  checkedString(content, "text content", TEXT_MAX_SIZE);
  return publish<TextShare>("text", { id: randomUUID(), content });
}
export function getTextShare(id: string) { return read<TextShare>("text", id, false); }
export function accessTextShare(id: string) { return read<TextShare>("text", id, true); }
export function editTextShare(id: string, content: string) {
  checkedString(content, "text content", TEXT_MAX_SIZE);
  return read<TextShare>("text", id, true, content);
}
export async function resolveToken(token: string, touch = false): Promise<
  { type: "file"; share: FileShare } | { type: "text"; share: TextShare } | null
> {
  if (!/^\d{1,6}$/.test(token)) return null;
  const raw = await redis.get(`${PREFIX}token:${token}`);
  if (!raw) return null;
  const mapping = JSON.parse(raw) as { kind: ShareKind; id: string };
  if (mapping.kind === "file") {
    const share = await read<FileShare>("file", mapping.id, touch, undefined, token);
    return share?.token === token ? { type: "file", share } : null;
  }
  if (mapping.kind === "text") {
    const share = await read<TextShare>("text", mapping.id, touch, undefined, token);
    return share?.token === token ? { type: "text", share } : null;
  }
  return null;
}

export async function checkShareStorage() { await redis.ping(); }
