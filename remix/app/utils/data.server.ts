import { matchSorter } from "match-sorter";
// import sortBy from "sort-by";
import orderBy from "lodash/orderBy";
import invariant from "tiny-invariant";
import HashMap from "./hashmap.server";
import Redis from "ioredis";
import dotenv from "dotenv";

dotenv.config();
console.log("redis env:", process.env.REDIS_HOST, process.env.REDIS_PORT);
const redis = new Redis({
  host: process.env.REDIS_HOST || "localhost",
  port: parseInt(process.env.REDIS_PORT || "6379", 10),
});

type FileMutation = {
  id?: string;
  filename?: string;
  type?: string;
  size?: number;
  magnet?: string;
  token?: string;
  notes?: string;
  favorite?: boolean;
  // [x]: Add attr `sender/receiver`
  owner?: boolean;
  lastAccessedAt?: string;
  accessCount?: number;
  updateCount?: number;
};

export type FileRecord = FileMutation & {
  id: string;
  createdAt: string;
};

const userFilesKey = (userId: string) => `user:${userId}:files`;

// [x]: Rename
const fileService = {
  async getAll(userId: string): Promise<FileRecord[]> {
    const keys = await redis.hkeys(userFilesKey(userId));
    const files = await Promise.all(
      keys.map((key) => redis.hget(userFilesKey(userId), key).then(JSON.parse))
    );
    return orderBy(files, "createdAt", "desc");
  },

  async get(userId: string, id: string): Promise<FileRecord | null> {
    const file = await redis.hget(userFilesKey(userId), id);
    return file ? JSON.parse(file) : null;
  },

  async create(userId: string, values: FileMutation): Promise<FileRecord> {
    // * Deduplicate here as `.create` should be duplicate-free
    const duplicateFile = await fileService.get_dup(userId, values);

    if (duplicateFile) {
      console.log("Duplicate file found:", duplicateFile.id);
      // Do not create, return existing file
      return duplicateFile;
    }

    // Create new file
    const id = values.id || Math.random().toString(36).substring(2, 9);
    const createdAt = new Date().toISOString();
    const newFile = {
      id,
      createdAt,
      lastAccessedAt: createdAt,
      accessCount: 1,
      updateCount: 0,
      ...values,
    };

    // Generate token for the file (using fileId, not magnet)
    if (id) {
      const token_str = await HashMap.genToken(id);
      newFile.token = token_str ?? undefined;
      console.log("Updated token:", newFile.token);
    }

    await redis.hset(userFilesKey(userId), id, JSON.stringify(newFile));
    return newFile;
  },

  async get_dup(
    userId: string,
    values: FileMutation
  ): Promise<FileRecord | null> {
    const files = await fileService.getAll(userId);
    if (!values) return null; // No values to compare
    const duplicateFile = files.find(
      (file) =>
        file.magnet === values.magnet && file.filename === values.filename
    );
    return duplicateFile || null;
  },

  async set(
    userId: string,
    id: string,
    values: FileMutation
  ): Promise<FileRecord> {
    const file = await fileService.get(userId, id);
    invariant(file, `No file found for ${id}`);

    const updatedFile = { ...file, ...values };

    // Generate token if not exists
    if (!updatedFile.token) {
      const token_str = await HashMap.genToken(id);
      updatedFile.token = token_str ?? undefined;
      console.log("Updated token:", updatedFile.token);
    }

    await redis.hset(userFilesKey(userId), id, JSON.stringify(updatedFile));
    return updatedFile;
  },

  async destroy(userId: string, id: string): Promise<null> {
    // Get file to get token
    const file = await this.get(userId, id);
    if (file && file.token) {
      // Update token status to "deleted" instead of deleting
      const data = await redis.hget("unifiedTokenMap", file.token);
      if (data) {
        const parsed = JSON.parse(data);
        parsed.status = "deleted";
        await redis.hset("unifiedTokenMap", file.token, JSON.stringify(parsed));
      }
    }
    // Delete from user files
    await redis.hdel(userFilesKey(userId), id);
    return null;
  },
};

export async function getFiles(userId: string, query?: string | null) {
  let files = await fileService.getAll(userId);

  if (query) {
    files = matchSorter(files, query, {
      keys: ["filename", "token"],
    });
  }
  return orderBy(files, "createdAt", "desc");
}

export async function createEmptyFile(userId: string, owner: boolean = true) {
  // Only owner can create file
  const file = await fileService.create(userId, { owner: owner });
  return file;
}

export async function getFile(userId: string, id: string) {
  return fileService.get(userId, id);
}

export async function updateFile(
  userId: string,
  fileId: string,
  updates: FileMutation,
  force: boolean = false,
  allowDelete: boolean = false
) {
  const file = await fileService.get(userId, fileId);

  if (!file) {
    throw new Error(`No file found for ${fileId}`);
  }
  // * Deduplicate here as `.set` has other use cases
  if (!force) {
    const duplicateFile = await fileService.get_dup(userId, updates);
    if (duplicateFile) {
      if (duplicateFile.notes === updates.notes) {
        if (allowDelete) {
          console.log("Deleting duplicate file:", duplicateFile.id);
          fileService.destroy(userId, fileId);
        }
        // Do not create, return existing file
        console.log("Duplicate file found:", duplicateFile.id);
        return duplicateFile;
      }
    }
  }

  const newFile = await fileService.set(userId, fileId, {
    ...file,
    ...updates,
  });
  return newFile;
}

export async function deleteFile(userId: string, id: string) {
  await fileService.destroy(userId, id);
}

// Merge visitor files to existing user files
export async function mergeFiles(
  userId: string,
  visitorId: string
): Promise<FileRecord[]> {
  const visitorFiles = await fileService.getAll(visitorId);
  console.log("Merging", visitorFiles.length, "files from", visitorId);
  await Promise.all(
    visitorFiles.map((file) => fileService.create(userId, file))
  );
  await redis.del(userFilesKey(visitorId));
  return fileService.getAll(userId);
}
