import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { restoreFileFromUndo } from "~/utils/data.server";
import { restoreTextFromUndo } from "~/utils/text.server";
import { requireSessionIdentity } from "~/utils/session.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }
  const { sub } = await requireSessionIdentity(request);
  const formData = await request.formData();
  const undoId = formData.get("undoId") as string | null;
  const undoType = formData.get("undoType") as string | null;
  if (!undoId || (undoType !== "file" && undoType !== "text")) {
    return json({ error: "A valid undoId and undoType are required" }, { status: 400 });
  }

  if (undoType === "file") {
    const file = await restoreFileFromUndo(undoId, sub);
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

  const text = await restoreTextFromUndo(undoId, sub);
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
