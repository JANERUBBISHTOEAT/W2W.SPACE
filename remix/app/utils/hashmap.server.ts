import dotenv from "dotenv";
import Redis from "ioredis";

dotenv.config();
console.log("redis env:", process.env.REDIS_HOST, process.env.REDIS_PORT);
const redis = new Redis({
  host: process.env.REDIS_HOST || "localhost",
  port: parseInt(process.env.REDIS_PORT || "6379", 10),
});

export default class HashMap {
  map: Map<number, string>;
  private static crypto: typeof import("crypto") | null = null;

  constructor() {
    this.map = new Map();
  }

  static async genKey(str: string): Promise<string> {
    // [x]: Check collision
    if (!this.crypto) this.crypto = await import("crypto");

    const maxRetries = 10;
    let attempts: number = 0;
    let token: number = -1;
    let hash: string;
    let token_len: number = 3;

    while (attempts++ < maxRetries) {
      // [x]: Make 6 a variable that increases when full
      hash = this.crypto.createHash("md5").update(str).digest("hex");
      token = parseInt(hash.slice(0, token_len), 16) % 10 ** token_len;

      const record = await this.get(token.toString());
      if (!record || record === str) {
        // "===" for "not a collision"
        console.log("magnet:", str, "has duplicate with:", record);
        break;
      } else {
        console.warn("magnet:", str, "has collision with:", record);
        token_len++;
      }
    }
    if (attempts === maxRetries) {
      console.error("genKey failed with attempts", attempts);
      console.info(
        "Redis health:",
        ((await this.getKeysCnt()) || -1) / 10 ** 6
      );
      token = -1;
    }

    return token.toString().padStart(token_len, "0");
  }

  static async set(
    token: string,
    fileId: string
    // expiry: number = 60 * 60
  ): Promise<void | null> {
    console.info("Redis health:", ((await this.getKeysCnt()) || -1) / 10 ** 6);
    if (!redis) return null;
    await redis.hset(
      "unifiedTokenMap",
      token,
      JSON.stringify({ type: "file", id: fileId, status: "OK" })
    );
    // await redis.expire("unifiedTokenMap", expiry);
  }

  static async get(token: string): Promise<string | null> {
    if (!redis) return null;
    const data = await redis.hget("unifiedTokenMap", token);
    if (data) {
      const parsed = JSON.parse(data);
      // For backward compatibility, return the full data structure
      // This method is used by old code that expects magnet
      if (parsed.type === "file") {
        return parsed.magnet || parsed.id;
      }
    }
    return null;
  }

  static async getKeysCnt(): Promise<number | null> {
    if (!redis) return null;
    return await redis.hlen("unifiedTokenMap");
  }

  static async del(token: string): Promise<void | null> {
    if (!redis) return null;
    await redis.hdel("unifiedTokenMap", token);
  }

  static async genToken(fileId: string): Promise<string | null> {
    if (!redis || !fileId) return "";
    const token_str = await HashMap.genKey(fileId);
    await HashMap.set(token_str, fileId);
    return token_str;
  }

  static async getFile(token: string): Promise<string | null> {
    if (!redis) return null;
    const data = await redis.hget("unifiedTokenMap", token);
    if (data) {
      const parsed = JSON.parse(data);
      return parsed.type === "file" ? parsed.id : null;
    }
    return null;
  }

  // Unified token storage with type field
  static async setText(token: string, textId: string): Promise<void | null> {
    if (!redis) return null;
    await redis.hset(
      "unifiedTokenMap",
      token,
      JSON.stringify({ type: "text", id: textId, status: "OK" })
    );
  }

  static async getText(token: string): Promise<string | null> {
    if (!redis) return null;
    const data = await redis.hget("unifiedTokenMap", token);
    if (data) {
      const parsed = JSON.parse(data);
      return parsed.type === "text" ? parsed.id : null;
    }
    return null;
  }

  // Get both token mappings simultaneously
  static async getBoth(token: string): Promise<{
    textId: string | null;
    fileId: string | null;
    type: string | null;
    status: string | null;
  }> {
    if (!redis) return { textId: null, fileId: null, type: null, status: null };
    const data = await redis.hget("unifiedTokenMap", token);
    if (!data) return { textId: null, fileId: null, type: null, status: null };

    const parsed = JSON.parse(data);
    if (parsed.type === "text") {
      return {
        textId: parsed.id,
        fileId: null,
        type: "text",
        status: parsed.status || "OK",
      };
    } else if (parsed.type === "file") {
      return {
        textId: null,
        fileId: parsed.id,
        type: "file",
        status: parsed.status || "OK",
      };
    }
    return { textId: null, fileId: null, type: null, status: null };
  }

  static async generateTextToken(textId: string): Promise<string | null> {
    if (!redis || !textId) return "";
    const token_str = await HashMap.genKey(textId);
    await HashMap.setText(token_str, textId);
    return token_str;
  }
}
