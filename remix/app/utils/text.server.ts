import { matchSorter } from "match-sorter";
import orderBy from "lodash/orderBy";
import invariant from "tiny-invariant";
import Redis from "ioredis";
import dotenv from "dotenv";

dotenv.config();
const redis = new Redis({
  host: process.env.REDIS_HOST || "localhost",
  port: parseInt(process.env.REDIS_PORT || "6379", 10),
});

export type TextType = "file" | "text";

export type TextMutation = {
  id?: string;
  content?: string;
  title?: string;
  language?: string;
  token?: string;
  favorite?: boolean;
  owner?: boolean;
  type?: TextType;
};

export type TextRecord = TextMutation & {
  id: string;
  createdAt: string;
  updatedAt: string;
};

const userTextsKey = (userId: string) => `user:${userId}:texts`;

const textService = {
  async getAll(userId: string): Promise<TextRecord[]> {
    const keys = await redis.hkeys(userTextsKey(userId));
    const texts = await Promise.all(
      keys.map((key) =>
        redis
          .hget(userTextsKey(userId), key)
          .then((data) => (data ? JSON.parse(data) : null))
          .then((text) => text as TextRecord)
      )
    );
    return orderBy(texts.filter(Boolean), "updatedAt", "desc");
  },

  async get(userId: string, id: string): Promise<TextRecord | null> {
    const text = await redis.hget(userTextsKey(userId), id);
    return text ? JSON.parse(text) : null;
  },

  async getByToken(token: string): Promise<TextRecord | null> {
    // Use unified token map
    const HashMap = (await import("./hashmap.server")).default;
    const textId = await HashMap.getText(token);
    if (!textId) return null;

    // Search across all users for this textId
    const userIds = await redis.keys("user:*:texts");
    for (const key of userIds) {
      const textData = await redis.hget(key, textId);
      if (textData) {
        const text: TextRecord = JSON.parse(textData);
        if (text.token === token) {
          return text;
        }
      }
    }
    return null;
  },

  async create(userId: string, values: TextMutation): Promise<TextRecord> {
    const id = values.id || Math.random().toString(36).substring(2, 9);
    const now = new Date().toISOString();

    // Generate token first
    const HashMap = (await import("./hashmap.server")).default;
    const token = (await HashMap.generateTextToken(id)) || "";

    const newText: TextRecord = {
      id,
      type: "text",
      createdAt: now,
      updatedAt: now,
      token,
      title: token, // Default title is token
      ...values,
    };

    await redis.hset(userTextsKey(userId), id, JSON.stringify(newText));
    return newText;
  },

  async set(
    userId: string,
    id: string,
    values: TextMutation
  ): Promise<TextRecord> {
    const text = await textService.get(userId, id);
    invariant(text, `No text found for ${id}`);

    const updatedText: TextRecord = {
      ...text,
      ...values,
      updatedAt: new Date().toISOString(),
    };
    await redis.hset(userTextsKey(userId), id, JSON.stringify(updatedText));
    return updatedText;
  },

  async destroy(userId: string, id: string): Promise<null> {
    await redis.hdel(userTextsKey(userId), id);
    return null;
  },
};

export async function getTexts(userId: string, query?: string | null) {
  let texts = await textService.getAll(userId);

  if (query) {
    texts = matchSorter(texts, query, {
      keys: ["title", "token"],
    });
  }
  return orderBy(texts, "updatedAt", "desc");
}

export async function createEmptyText(userId: string, owner: boolean = true) {
  const text = await textService.create(userId, {
    content: "# Welcome to Text Editor\n\nStart typing...",
    title: "Untitled Text",
    language: "markdown",
    owner: owner,
    type: "text",
  });
  return text;
}

export async function getText(userId: string, id: string) {
  return textService.get(userId, id);
}

export async function getTextByToken(token: string) {
  return textService.getByToken(token);
}

export async function updateText(
  userId: string,
  textId: string,
  updates: TextMutation
) {
  const text = await textService.get(userId, textId);

  if (!text) {
    throw new Error(`No text found for ${textId}`);
  }

  const updatedText = await textService.set(userId, textId, {
    ...text,
    ...updates,
  });
  return updatedText;
}

export async function deleteText(userId: string, id: string) {
  await textService.destroy(userId, id);
}

export async function mergeTexts(
  userId: string,
  visitorId: string
): Promise<TextRecord[]> {
  const visitorTexts = await textService.getAll(visitorId);
  console.log("Merging", visitorTexts.length, "texts from", visitorId);
  await Promise.all(
    visitorTexts.map((text) => textService.create(userId, text))
  );
  await redis.del(userTextsKey(visitorId));
  return textService.getAll(userId);
}
