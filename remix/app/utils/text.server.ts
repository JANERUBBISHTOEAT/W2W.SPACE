import { createTextShare, editTextShare } from "./share.server";
export { getTextShare as getTextByTextId, accessTextShare as accessText, cancelTextDraft } from "./share.server";
export function createEmptyText() { return createTextShare(undefined, { draft: true }); }
export function updateTextByTextId(id: string, updates: { content: string }) {
  return editTextShare(id, updates.content);
}
