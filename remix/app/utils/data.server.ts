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
  lastEditedAt?: string;
};

export type FileRecord = FileMutation & {
  id: string;
  createdAt: string;
  status?: string;
};

const userFilesKey = (userId: string) => `user:${userId}:files`;

/** Count how many file records (across all users) use this token. Same token can be shared by uploader + downloader. */
export async function countFilesWithToken(token: string): Promise<number> {
  let count = 0;
  const userIds = await redis.keys("user:*:files");
  for (const key of userIds) {
    const files = await redis.hgetall(key);
    for (const fileJson of Object.values(files)) {
      const file = JSON.parse(fileJson as string);
      if (file.token === token) count++;
    }
  }
  return count;
}

// [x]: Rename
const fileService = {
  async getAll(userId: string): Promise<FileRecord[]> {
    const keys = await redis.hkeys(userFilesKey(userId));
    const files = await Promise.all(
      keys
        .map((key) =>
          redis
            .hget(userFilesKey(userId), key)
            .then((data) => (data ? JSON.parse(data) : null)),
        )
        .filter(Boolean),
    );

    // Add status from unifiedTokenMap
    const HashMap = (await import("./hashmap.server")).default;
    for (const file of files) {
      if (file.token) {
        const status = await HashMap.getBoth(file.token);
        file.status = status.status || "OK";
      }
    }

    // Sort by lastEditedAt if available, otherwise lastAccessedAt
    const sortedFiles = files.sort((a, b) => {
      const dateA = a.lastEditedAt || a.lastAccessedAt || a.createdAt;
      const dateB = b.lastEditedAt || b.lastAccessedAt || b.createdAt;
      return new Date(dateB).getTime() - new Date(dateA).getTime();
    });

    return sortedFiles;
  },

  async get(userId: string, id: string): Promise<FileRecord | null> {
    const file = await redis.hget(userFilesKey(userId), id);
    return file ? JSON.parse(file) : null;
  },

  async getByFileId(fileId: string): Promise<FileRecord | null> {
    // Search across all users for this fileId
    const userIds = await redis.keys("user:*:files");
    for (const key of userIds) {
      const fileData = await redis.hget(key, fileId);
      if (fileData) {
        const file: FileRecord = JSON.parse(fileData);
        return file;
      }
    }
    return null;
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
      lastEditedAt: createdAt,
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

  /** Find existing file with same magnet+filename; optionally exclude one id (e.g. current file when updating). */
  async get_dup(
    userId: string,
    values: FileMutation,
    excludeFileId?: string,
  ): Promise<FileRecord | null> {
    const files = await fileService.getAll(userId);
    if (!values) return null;
    const duplicateFile = files.find(
      (file) =>
        file.id !== excludeFileId &&
        file.magnet === values.magnet &&
        file.filename === values.filename,
    );
    return duplicateFile || null;
  },

  async set(
    userId: string,
    id: string,
    values: FileMutation,
  ): Promise<FileRecord> {
    const file = await fileService.get(userId, id);
    invariant(file, `No file found for ${id}`);

    const updatedFile = { ...file, ...values };

    // Token is only set at create(); do not generate on update.

    await redis.hset(userFilesKey(userId), id, JSON.stringify(updatedFile));
    return updatedFile;
  },

  async destroy(userId: string, id: string): Promise<null> {
    const file = await this.get(userId, id);
    // Delete from user files first
    await redis.hdel(userFilesKey(userId), id);
    // Only mark token as "deleted" if this was the last file using it (same token can be shared by uploader + downloader)
    if (file?.token) {
      const count = await countFilesWithToken(file.token);
      if (count === 0) {
        const data = await redis.hget("unifiedTokenMap", file.token);
        if (data) {
          const parsed = JSON.parse(data);
          parsed.status = "deleted";
          await redis.hset(
            "unifiedTokenMap",
            file.token,
            JSON.stringify(parsed),
          );
        }
      }
    }
    return null;
  },

  async setByFileId(
    id: string,
    values: FileMutation,
  ): Promise<FileRecord | null> {
    // Find which user owns this file
    const userIds = await redis.keys("user:*:files");
    for (const key of userIds) {
      const fileData = await redis.hget(key, id);
      if (fileData) {
        const file: FileRecord = JSON.parse(fileData);

        const updatedFile = { ...file, ...values };

        // Token is only set at create(); do not generate on update.

        await redis.hset(key, id, JSON.stringify(updatedFile));
        return updatedFile;
      }
    }
    return null;
  },

  async destroyByFileId(id: string): Promise<null> {
    const userIds = await redis.keys("user:*:files");
    for (const key of userIds) {
      const fileData = await redis.hget(key, id);
      if (fileData) {
        const file: FileRecord = JSON.parse(fileData);
        await redis.hdel(key, id);
        // Only mark token as "deleted" if this was the last file using it
        if (file.token) {
          const count = await countFilesWithToken(file.token);
          if (count === 0) {
            const data = await redis.hget("unifiedTokenMap", file.token);
            if (data) {
              const parsed = JSON.parse(data);
              parsed.status = "deleted";
              await redis.hset(
                "unifiedTokenMap",
                file.token,
                JSON.stringify(parsed),
              );
            }
          }
        }
        return null;
      }
    }
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

export async function getFileByFileId(fileId: string) {
  return fileService.getByFileId(fileId);
}

export async function updateFile(
  userId: string,
  fileId: string,
  updates: FileMutation,
  force: boolean = false,
  allowDelete: boolean = false,
) {
  const file = await fileService.get(userId, fileId);

  if (!file) {
    throw new Error(`No file found for ${fileId}`);
  }
  // * Deduplicate: if another file already has same magnet+filename, keep that one and drop current.
  if (!force) {
    const duplicateFile = await fileService.get_dup(userId, updates, fileId);
    if (duplicateFile) {
      const notesMatch = (duplicateFile.notes ?? "") === (updates.notes ?? "");
      if (notesMatch && allowDelete) {
        console.log("Deleting duplicate file:", fileId);
        fileService.destroy(userId, fileId);
        console.log(
          "Duplicate file found, returning existing:",
          duplicateFile.id,
        );
        return duplicateFile;
      }
      if (notesMatch) {
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

const UNDO_TTL_SEC = 60;

export async function saveFileUndo(
  userId: string,
  fileId: string,
  file: FileRecord,
): Promise<void> {
  await redis.set(
    `undo:file:${fileId}`,
    JSON.stringify({ userId, file }),
    "EX",
    UNDO_TTL_SEC,
  );
}

export async function getFileUndo(
  fileId: string,
): Promise<{ userId: string; file: FileRecord } | null> {
  const raw = await redis.get(`undo:file:${fileId}`);
  if (!raw) return null;
  return JSON.parse(raw);
}

export async function restoreFileFromUndo(
  fileId: string,
): Promise<FileRecord | null> {
  const data = await getFileUndo(fileId);
  if (!data) return null;
  const { userId, file } = data;
  await redis.hset(userFilesKey(userId), file.id, JSON.stringify(file));
  if (file.token) {
    const existing = await redis.hget("unifiedTokenMap", file.token);
    if (existing) {
      const parsed = JSON.parse(existing);
      parsed.status = "OK";
      await redis.hset(
        "unifiedTokenMap",
        file.token,
        JSON.stringify(parsed),
      );
    }
  }
  await redis.del(`undo:file:${fileId}`);
  return file;
}

export async function deleteFile(userId: string, id: string) {
  await fileService.destroy(userId, id);
}

export async function updateFileByFileId(
  fileId: string,
  updates: FileMutation,
) {
  return fileService.setByFileId(fileId, updates);
}

export async function deleteFileByFileId(fileId: string) {
  await fileService.destroyByFileId(fileId);
}

// Merge visitor files to existing user files
export async function mergeFiles(
  userId: string,
  visitorId: string,
): Promise<FileRecord[]> {
  const visitorFiles = await fileService.getAll(visitorId);
  console.log("Merging", visitorFiles.length, "files from", visitorId);
  await Promise.all(
    visitorFiles.map((file) => fileService.create(userId, file)),
  );
  await redis.del(userFilesKey(visitorId));
  return fileService.getAll(userId);
}
