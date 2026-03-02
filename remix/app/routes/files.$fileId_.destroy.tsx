import type { ActionFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import invariant from "tiny-invariant";
import { deleteFile, getFile, saveFileUndo } from "~/utils/data.server";
import { getUserSession, getVisitorSession } from "~/utils/session.server";

export const action = async ({ params, request }: ActionFunctionArgs) => {
  invariant(params.fileId, "Missing fileId param");
  const user = await getUserSession(request);
  const visitor = await getVisitorSession(request);
  const sub = user?.sub || visitor?.sub;
  const file = await getFile(sub, params.fileId);
  if (file) await saveFileUndo(sub, params.fileId, file);
  await deleteFile(sub, params.fileId);
  return redirect(
    `/?message=Deleted&undoId=${encodeURIComponent(params.fileId)}&undoType=file`,
  );
};
