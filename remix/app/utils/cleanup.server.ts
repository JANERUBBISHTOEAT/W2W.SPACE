import Redis from "ioredis";
import { config } from "dotenv";

config();
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
          const tokenData = await redis.hget("unifiedTokenMap", text.token);
          if (tokenData) {
            const parsed = JSON.parse(tokenData);
            if (parsed.type === "text" && parsed.id === id) {
              parsed.status = "deleted";
              await redis.hset(
                "unifiedTokenMap",
                text.token,
                JSON.stringify(parsed)
              );
            }
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
        // Delete from user's files first
        await redis.hdel(key, id);
        deletedCount++;
        // Only mark token as "deleted" if no other file record uses it (same token can be shared by uploader + downloader)
        if (file.token) {
          const { countFilesWithToken } = await import("./data.server");
          const count = await countFilesWithToken(file.token);
          if (count === 0) {
            const tokenData = await redis.hget("unifiedTokenMap", file.token);
            if (tokenData) {
              const parsed = JSON.parse(tokenData);
              if (parsed.type === "file") {
                parsed.status = "deleted";
                await redis.hset(
                  "unifiedTokenMap",
                  file.token,
                  JSON.stringify(parsed)
                );
              }
            }
          }
        }
        console.log(`Deleted expired file: ${id}`);
      }
    }
  }

  console.log(`Cleanup completed. Deleted ${deletedCount} expired records.`);
}
