import { createHash } from "node:crypto";
import { config } from "dotenv";
import Redis from "ioredis";

config();
const redis = new Redis({
  host: process.env.REDIS_HOST || "localhost",
  port: parseInt(process.env.REDIS_PORT || "6379", 10),
});

const TOKEN_MAP = "unifiedTokenMap";
type TokenType = "file" | "text";
type TokenRecord = {
  type: TokenType;
  id?: string;
  magnet?: string;
  status?: string;
};

function parseTokenRecord(raw: string | null): TokenRecord | null {
  if (!raw) return null;
  try {
    const record: unknown = JSON.parse(raw);
    if (!record || typeof record !== "object" || !("type" in record)) {
      return null;
    }
    if (record.type !== "file" && record.type !== "text") return null;
    return {
      type: record.type,
      id: "id" in record && typeof record.id === "string" ? record.id : undefined,
      magnet:
        "magnet" in record && typeof record.magnet === "string"
          ? record.magnet
          : undefined,
      status:
        "status" in record && typeof record.status === "string"
          ? record.status
          : "OK",
    };
  } catch {
    return null;
  }
}

export default class HashMap {
  map: Map<number, string>;

  constructor() {
    this.map = new Map();
  }

  private static async reserveToken(
    token: string,
    id: string,
    type: TokenType,
  ): Promise<boolean> {
    const inserted = await redis.hsetnx(
      TOKEN_MAP,
      token,
      JSON.stringify({ type, id, status: "OK" }),
    );
    if (inserted === 1) return true;

    // Repeated creation/merge of the same record may reuse its token. A token
    // belonging to another record (including a tombstone) is never overwritten.
    const existing = parseTokenRecord(await redis.hget(TOKEN_MAP, token));
    return (
      existing?.type === type &&
      existing.id === id &&
      existing.status !== "deleted"
    );
  }

  static async genKey(id: string, type: TokenType = "file"): Promise<string> {
    if (!id) throw new Error("A record ID is required to allocate a token");
    // Keep the existing decimal token format and deterministic candidates so
    // existing links and idempotent record merges remain compatible.
    const hash = createHash("md5").update(id).digest("hex");
    for (let length = 3; length <= 12; length++) {
      const token = (parseInt(hash.slice(0, length), 16) % 10 ** length)
        .toString()
        .padStart(length, "0");
      if (await this.reserveToken(token, id, type)) return token;
    }
    throw new Error("Unable to allocate a unique sharing token");
  }

  static async set(token: string, fileId: string): Promise<void> {
    if (!(await this.reserveToken(token, fileId, "file"))) {
      throw new Error("Sharing token already belongs to another record");
    }
  }

  static async get(token: string): Promise<string | null> {
    const record = parseTokenRecord(await redis.hget(TOKEN_MAP, token));
    // Retain the legacy magnet return value when reading older file mappings.
    return record?.type === "file" && record.status !== "deleted"
      ? record.magnet || record.id || null
      : null;
  }

  static async getKeysCnt(): Promise<number> {
    return redis.hlen(TOKEN_MAP);
  }

  static async del(token: string): Promise<void> {
    await redis.hdel(TOKEN_MAP, token);
  }

  static async genToken(fileId: string): Promise<string> {
    if (!fileId) return "";
    return this.genKey(fileId, "file");
  }

  static async getFile(token: string): Promise<string | null> {
    const record = parseTokenRecord(await redis.hget(TOKEN_MAP, token));
    return record?.type === "file" && record.status !== "deleted"
      ? record.id || null
      : null;
  }

  static async setText(token: string, textId: string): Promise<void> {
    if (!(await this.reserveToken(token, textId, "text"))) {
      throw new Error("Sharing token already belongs to another record");
    }
  }

  static async getText(token: string): Promise<string | null> {
    const record = parseTokenRecord(await redis.hget(TOKEN_MAP, token));
    return record?.type === "text" && record.status !== "deleted"
      ? record.id || null
      : null;
  }

  static async getBoth(token: string): Promise<{
    textId: string | null;
    fileId: string | null;
    type: TokenType | null;
    status: string | null;
  }> {
    const record = parseTokenRecord(await redis.hget(TOKEN_MAP, token));
    return {
      textId: record?.type === "text" ? record.id || null : null,
      fileId: record?.type === "file" ? record.id || null : null,
      type: record?.type || null,
      status: record?.status || null,
    };
  }

  static async generateTextToken(textId: string): Promise<string> {
    if (!textId) return "";
    return this.genKey(textId, "text");
  }
}
