import { createTextShare, editTextShare } from "./share.server";
export { getTextShare as getTextByTextId, accessTextShare as accessText } from "./share.server";
export type { TextShare as TextRecord } from "./share.server";
export function createEmptyText() { return createTextShare(); }
export function updateTextByTextId(id: string, updates: { content: string }) {
  return editTextShare(id, updates.content);
}
