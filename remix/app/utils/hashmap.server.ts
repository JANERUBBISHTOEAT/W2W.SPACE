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
    magnet: string
    // expiry: number = 60 * 60
  ): Promise<void | null> {
    console.info("Redis health:", ((await this.getKeysCnt()) || -1) / 10 ** 6);
    if (!redis) return null;
    await redis.hset("tokenMap", token, magnet);
    // await redis.expire("tokenMap", expiry);
  }

  static async get(token: string): Promise<string | null> {
    if (!redis) return null;
    return await redis.hget("tokenMap", token);
  }

  static async getKeysCnt(): Promise<number | null> {
    if (!redis) return null;
    return await redis.hlen("tokenMap");
  }

  static async del(token: string): Promise<void | null> {
    if (!redis) return null;
    await redis.hdel("tokenMap", token);
  }

  static async genToken(magnet: string): Promise<string | null> {
    if (!redis || !magnet) return "";
    const token_str = await HashMap.genKey(magnet);
    HashMap.set(token_str, magnet);
    return token_str;
  }

  // Text-specific token methods
  static async setText(token: string, textId: string): Promise<void | null> {
    if (!redis) return null;
    await redis.hset("textTokenMap", token, textId);
  }

  static async getText(token: string): Promise<string | null> {
    if (!redis) return null;
    return await redis.hget("textTokenMap", token);
  }

  // Get both token mappings simultaneously
  static async getBoth(
    token: string
  ): Promise<{ textId: string | null; magnet: string | null }> {
    if (!redis) return { textId: null, magnet: null };
    const [textId, magnet] = await Promise.all([
      redis.hget("textTokenMap", token),
      redis.hget("tokenMap", token),
    ]);
    return {
      textId: textId || null,
      magnet: magnet || null,
    };
  }

  static async generateTextToken(textId: string): Promise<string | null> {
    if (!redis || !textId) return "";
    const token_str = await HashMap.genKey(textId);
    HashMap.setText(token_str, textId);
    return token_str;
  }
}
