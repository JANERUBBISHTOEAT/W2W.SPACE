import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import invariant from "tiny-invariant";
import { restoreFileFromUndo } from "~/utils/data.server";
import { restoreTextFromUndo } from "~/utils/text.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }
  const formData = await request.formData();
  const undoId = formData.get("undoId") as string | null;
  const undoType = formData.get("undoType") as string | null;
  invariant(undoId, "undoId required");
  invariant(undoType === "file" || undoType === "text", "undoType must be file or text");

  if (undoType === "file") {
    const file = await restoreFileFromUndo(undoId);
    if (!file) {
      return json({ error: "Undo expired or invalid" }, { status: 404 });
    }
    return json({
      success: true,
      type: "file",
      id: file.id,
      url: `/files/${file.id}`,
    });
  }

  const text = await restoreTextFromUndo(undoId);
  if (!text) {
    return json({ error: "Undo expired or invalid" }, { status: 404 });
  }
  return json({
    success: true,
    type: "text",
    id: text.id,
    url: `/texts/${text.id}`,
  });
};
