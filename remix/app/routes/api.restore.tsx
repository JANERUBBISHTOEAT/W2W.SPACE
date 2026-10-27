import { type ActionFunctionArgs } from "react-router";
import { restoreFileFromUndo } from "~/utils/data.server";
import { restoreTextFromUndo } from "~/utils/text.server";
import { requireSessionIdentity } from "~/utils/session.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  const { sub } = await requireSessionIdentity(request);
  const formData = await request.formData();
  const undoId = formData.get("undoId") as string | null;
  const undoType = formData.get("undoType") as string | null;
  if (!undoId || (undoType !== "file" && undoType !== "text")) {
    return Response.json({ error: "A valid undoId and undoType are required" }, { status: 400 });
  }

  if (undoType === "file") {
    const file = await restoreFileFromUndo(undoId, sub);
    if (!file) {
      return Response.json({ error: "Undo expired or invalid" }, { status: 404 });
    }
    return Response.json({
      success: true,
      type: "file",
      id: file.id,
      url: `/files/${file.id}`,
    });
  }

  const text = await restoreTextFromUndo(undoId, sub);
  if (!text) {
    return Response.json({ error: "Undo expired or invalid" }, { status: 404 });
  }
  return Response.json({
    success: true,
    type: "text",
    id: text.id,
    url: `/texts/${text.id}`,
  });
};
