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
export type TextShare = SharedRecord & { content: string; draft?: true };
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
  -- Delayed requests must not move an existing Share backwards in LRU order.
  if not record.lastAccessedAt or record.lastAccessedAt < ARGV[2] then
    record.lastAccessedAt = ARGV[2]
  end
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
const recycleLua = renewLua + `
local existing = redis.call('GET', KEYS[1])
if existing then return renew(KEYS[1], cjson.decode(existing)) end
local record = cjson.decode(ARGV[5])
-- A candidate may have expired while the caller was finding the oldest Share.
for _, token in ipairs(cjson.decode(ARGV[6])) do
  if redis.call('EXISTS', ARGV[3] .. 'token:' .. token) == 0 then
    record.token = token
    return renew(KEYS[1], record)
  end
end
if #KEYS < 3 then return false end
local raw = redis.call('GET', KEYS[2])
local alias = redis.call('GET', KEYS[3])
if not raw or not alias then return false end
local oldest = cjson.decode(raw)
local mapping = cjson.decode(alias)
if oldest.lastAccessedAt ~= ARGV[7]
  or KEYS[3] ~= ARGV[3] .. 'token:' .. oldest.token
  or mapping.id ~= oldest.id
  or KEYS[2] ~= ARGV[3] .. 'share:' .. mapping.kind .. ':' .. mapping.id then
  return false
end
record.token = oldest.token
redis.call('DEL', KEYS[2], KEYS[3])
return renew(KEYS[1], record)
`;
const accessLua = renewLua + `
local existing = redis.call('GET', KEYS[1])
if not existing then return false end
local record = cjson.decode(existing)
if ARGV[7] ~= '' and record.token ~= ARGV[7] then return false end
if ARGV[5] == 'edit' then
  record.content = ARGV[6]
  record.draft = nil
end
return renew(KEYS[1], record)
`;
const cancelTextDraftLua = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local record = cjson.decode(raw)
if record.draft ~= true or record.id ~= ARGV[2] then return 0 end
local tokenKey = ARGV[1] .. 'token:' .. record.token
local alias = redis.call('GET', tokenKey)
if alias then
  local mapping = cjson.decode(alias)
  if mapping.kind == 'text' and mapping.id == record.id then
    redis.call('DEL', tokenKey)
  end
end
redis.call('DEL', KEYS[1])
return 1
`;
function argumentsFor(kind: ShareKind) {
  return [String(SHARE_TTL_SECONDS * 1000), new Date().toISOString(), PREFIX, kind];
}
type OldestShare = { key: string; token: string; lastAccessedAt: string; time: number };
async function findOldestShare(): Promise<OldestShare | null> {
  let cursor = "0";
  let oldest: OldestShare | null = null;
  // Only exhaustion needs this scan. Keep it outside Lua so other Redis users
  // can keep working; the final script checks the selected record atomically.
  do {
    const [next, keys] = await redis.scan(cursor, "MATCH", `${PREFIX}share:*`, "COUNT", 256);
    cursor = next;
    if (!keys.length) continue;
    // Text records may be 10 MB; bound each fetch independently of SCAN COUNT.
    for (let offset = 0; offset < keys.length; offset += 8) {
      const batch = keys.slice(offset, offset + 8);
      const records = await redis.mget(...batch);
      const candidates = records.flatMap((raw, index) => {
        if (!raw) return [];
        const record = JSON.parse(raw) as SharedRecord;
        const key = batch[index];
        const kind = key.slice(`${PREFIX}share:`.length).split(":")[0];
        const time = Date.parse(record.lastAccessedAt);
        if ((kind !== "file" && kind !== "text") || key !== recordKey(kind, record.id)
          || !/^\d{1,6}$/.test(record.token) || !Number.isFinite(time)) return [];
        return [{ key, kind, id: record.id, token: record.token, lastAccessedAt: record.lastAccessedAt, time }];
      });
      if (!candidates.length) continue;
      const aliases = await redis.mget(...candidates.map(({ token }) => `${PREFIX}token:${token}`));
      candidates.forEach((candidate, index) => {
        if (!aliases[index]) return;
        const mapping = JSON.parse(aliases[index]!) as { kind: ShareKind; id: string };
        if (mapping.kind !== candidate.kind || mapping.id !== candidate.id) return;
        if (!oldest || candidate.time < oldest.time || (candidate.time === oldest.time && candidate.key < oldest.key)) {
          oldest = candidate;
        }
      });
    }
  } while (cursor !== "0");
  return oldest;
}
async function publish<T extends SharedRecord>(kind: ShareKind, record: Omit<T, "token" | "lastAccessedAt">): Promise<T> {
  const candidates: string[] = [];
  for (let length = 1; length <= 6; length++) {
    const minimum = length === 1 ? 0 : 10 ** (length - 1);
    const token = randomInt(minimum, 10 ** length).toString();
    candidates.push(token);
    const raw = await redis.eval(publishLua, 2, recordKey(kind, record.id), `${PREFIX}token:${token}`,
      ...argumentsFor(kind), JSON.stringify({ ...record, token }));
    if (typeof raw === "string") return JSON.parse(raw) as T;
  }
  for (let attempt = 0; attempt < 32; attempt++) {
    const oldest = await findOldestShare();
    const keys = [recordKey(kind, record.id)];
    if (oldest) keys.push(oldest.key, `${PREFIX}token:${oldest.token}`);
    const raw = await redis.eval(recycleLua, keys.length, ...keys, ...argumentsFor(kind),
      JSON.stringify(record), JSON.stringify(candidates), oldest?.lastAccessedAt || "");
    if (typeof raw === "string") return JSON.parse(raw) as T;
    // Only inconsistent/orphan aliases can occupy every candidate while no
    // live Share exists. Never delete an unrelated key to repair such data.
    if (!oldest) throw new Error("Unable to allocate a unique sharing token");
    // Another request accessed or reclaimed this Share. Select again.
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
export function createTextShare(content = "# Welcome to Text Editor\n\nStart typing...", options: { draft?: boolean } = {}) {
  checkedString(content, "text content", TEXT_MAX_SIZE);
  return publish<TextShare>("text", { id: randomUUID(), content, ...(options.draft ? { draft: true as const } : {}) });
}
export function getTextShare(id: string) { return read<TextShare>("text", id, false); }
export function accessTextShare(id: string) { return read<TextShare>("text", id, true); }
export function editTextShare(id: string, content: string) {
  checkedString(content, "text content", TEXT_MAX_SIZE);
  return read<TextShare>("text", id, true, content);
}
/** Cancelling a fresh editor can never delete a text saved by another tab. */
export async function cancelTextDraft(id: string): Promise<boolean> {
  if (!/^[a-f\d-]{36}$/i.test(id)) return false;
  return await redis.eval(cancelTextDraftLua, 1, recordKey("text", id), PREFIX, id) === 1;
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
