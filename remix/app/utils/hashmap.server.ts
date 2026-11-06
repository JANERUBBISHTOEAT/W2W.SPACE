import { resolveToken } from "./share.server";

/** Read-only short-link lookup; allocation belongs to Share creation. */
export default class HashMap {
  static async getBoth(token: string) {
    const result = await resolveToken(token);
    return {
      type: result?.type ?? null,
      status: result ? "OK" : null,
      fileId: result?.type === "file" ? result.share.id : null,
      textId: result?.type === "text" ? result.share.id : null,
    };
  }
}
