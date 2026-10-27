import {
  type ActionFunctionArgs,
  redirect,
} from "react-router";
import invariant from "tiny-invariant";
import { deleteFile, getFile, saveFileUndo } from "~/utils/data.server";
import { requireSessionIdentity } from "~/utils/session.server";

export const action = async ({ params, request }: ActionFunctionArgs) => {
  invariant(params.fileId, "Missing fileId param");
  const { sub } = await requireSessionIdentity(request);
  const file = await getFile(sub, params.fileId);
  if (!file) throw new Response("Not Found", { status: 404 });
  await saveFileUndo(sub, params.fileId, file);
  await deleteFile(sub, params.fileId);
  return redirect(
    `/?message=Deleted&undoId=${encodeURIComponent(params.fileId)}&undoType=file`,
  );
};
