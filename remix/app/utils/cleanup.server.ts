import Redis from "ioredis";
import dotenv from "dotenv";

dotenv.config();
const redis = new Redis({
  host: process.env.REDIS_HOST || "localhost",
  port: parseInt(process.env.REDIS_PORT || "6379", 10),
});

export async function cleanupExpiredRecords() {
  // Delete records that are 30 days old (based on lastEditedAt)
  const thirtyDaysAgo = new Date(
    Date.now() - 30 * 24 * 60 * 60 * 1000
  ).toISOString();

  // Get all user keys
  const userTextsKeys = await redis.keys("user:*:texts");
  const userFilesKeys = await redis.keys("user:*:files");

  let deletedCount = 0;

  // Check texts
  for (const key of userTextsKeys) {
    const texts = await redis.hgetall(key);
    for (const [id, textJson] of Object.entries(texts)) {
      const text = JSON.parse(textJson as string);
      // Use lastEditedAt if available, otherwise use lastAccessedAt
      const lastDate = text.lastEditedAt || text.lastAccessedAt;
      if (lastDate && lastDate < thirtyDaysAgo) {
        // Mark as deleted in unifiedTokenMap
        if (text.token) {
          const HashMap = (await import("./hashmap.server")).default;
          const tokenData = await redis.hget("unifiedTokenMap", text.token);
          if (tokenData) {
            const parsed = JSON.parse(tokenData);
            parsed.status = "deleted";
            await redis.hset(
              "unifiedTokenMap",
              text.token,
              JSON.stringify(parsed)
            );
          }
        }
        // Delete from user's texts to save memory
        await redis.hdel(key, id);
        deletedCount++;
        console.log(`Deleted expired text: ${id}`);
      }
    }
  }

  // Check files
  for (const key of userFilesKeys) {
    const files = await redis.hgetall(key);
    for (const [id, fileJson] of Object.entries(files)) {
      const file = JSON.parse(fileJson as string);
      // Use lastEditedAt if available, otherwise use lastAccessedAt
      const lastDate = file.lastEditedAt || file.lastAccessedAt;
      if (lastDate && lastDate < thirtyDaysAgo) {
        // Mark as deleted in unifiedTokenMap
        if (file.token) {
          const HashMap = (await import("./hashmap.server")).default;
          const tokenData = await redis.hget("unifiedTokenMap", file.token);
          if (tokenData) {
            const parsed = JSON.parse(tokenData);
            parsed.status = "deleted";
            await redis.hset(
              "unifiedTokenMap",
              file.token,
              JSON.stringify(parsed)
            );
          }
        }
        // Delete from user's files to save memory
        await redis.hdel(key, id);
        deletedCount++;
        console.log(`Deleted expired file: ${id}`);
      }
    }
  }

  console.log(`Cleanup completed. Deleted ${deletedCount} expired records.`);
}

export async function enforceTokenLimit() {
  // Get unifiedTokenMap to check for 6-digit tokens
  const tokens = await redis.hgetall("unifiedTokenMap");

  // Check if any token is 6 digits or longer
  for (const [token, dataStr] of Object.entries(tokens)) {
    if (token.length >= 6) {
      console.warn(
        `6-digit token detected: ${token}, need to clean up oldest record`
      );

      // Find oldest record across all users (based on lastEditedAt)
      let oldestRecord: {
        key: string;
        id: string;
        lastDate: string;
      } | null = null;

      const userTextsKeys = await redis.keys("user:*:texts");
      const userFilesKeys = await redis.keys("user:*:files");

      for (const key of [...userTextsKeys, ...userFilesKeys]) {
        const records = await redis.hgetall(key);
        for (const [id, recordJson] of Object.entries(records)) {
          const record = JSON.parse(recordJson as string);
          // Use lastEditedAt if available, otherwise use lastAccessedAt
          const lastDate = record.lastEditedAt || record.lastAccessedAt;
          if (lastDate && (!oldestRecord || lastDate < oldestRecord.lastDate)) {
            oldestRecord = { key, id, lastDate };
          }
        }
      }

      if (oldestRecord) {
        await redis.hdel(oldestRecord.key, oldestRecord.id);
        console.log(
          `Deleted oldest record to make room: ${oldestRecord.id} from ${oldestRecord.key}`
        );
      }

      break; // Only delete one at a time
    }
  }
}
