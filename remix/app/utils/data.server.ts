// Personal File records live only in the browser; shared resources have no users.
export { publishShare, getShare, accessShare, normalizeInfoHash, parseMagnet } from "./share.server";
export type { FileShare, FileMetadata } from "./share.server";
