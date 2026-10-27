import { type ActionFunctionArgs } from "react-router";
import invariant from "tiny-invariant";
import {
  countFilesWithToken,
  createEmptyFile,
  getFile,
  getFileByToken,
  getFiles,
  updateFile,
} from "~/utils/data.server";
import { FIELD_MAX_SIZE } from "~/utils/constants";
import HashMap from "~/utils/hashmap.server";
import { getUserSession, getVisitorSession } from "~/utils/session.server";

export const action = async ({ params, request }: ActionFunctionArgs) => {
  invariant(params.fileId, "Missing fileId param");
  const user = await getUserSession(request);
  const visitor = await getVisitorSession(request);
  const sub = user?.sub || visitor?.sub;
  if (!sub) return Response.json({ error: "A session is required" }, { status: 401 });

  const formData = await request.formData();
  const intent = formData.get("intent");
  if (intent === "acquireToken") {
    const magnet = formData.get("magnet");
    if (typeof magnet !== "string" || !magnet.startsWith("magnet:?") || new TextEncoder().encode(magnet).length > FIELD_MAX_SIZE) {
      return Response.json({ error: "A valid magnet link is required" }, { status: 400 });
    }
    if (params.fileId !== "new") {
      const file = await getFile(sub, params.fileId);
      if (!file?.token) return Response.json({ error: "File not found" }, { status: 404 });
      return Response.json({ fileId: file.id, token: file.token, magnet, intent });
    }
    const existing = (await getFiles(sub)).find((file) => file.magnet === magnet);
    const file = existing?.token ? existing : await createReceiveFile(sub, magnet);
    return Response.json({ fileId: file.id, token: file.token, magnet, intent });
  }

  if (intent === "acquireMagnet") {
    const token = formData.get("token");
    if (typeof token !== "string" || !token || token.length > FIELD_MAX_SIZE) {
      return Response.json({ error: "A token is required" }, { status: 400 });
    }
    const mapping = await HashMap.getBoth(token);
    if (mapping.status === "deleted") {
      return Response.json({ error: "This shared item was deleted" }, { status: 404 });
    }
    if (mapping.type === "text" && mapping.textId) {
      return Response.json({ intent, textId: mapping.textId, magnet: null, type: "text" });
    }
    const source = mapping.type === "file" ? await getFileByToken(token) : null;
    if (!source?.magnet) {
      return Response.json({ intent, type: null, magnet: null, token });
    }
    let fileId: string | undefined;
    if (params.fileId === "new") {
      const existing = (await getFiles(sub)).find((file) => file.token === token);
      const file = existing ?? await createReceiveFile(sub, source.magnet, token);
      fileId = file.id;
    }
    return Response.json({ fileId, magnet: source.magnet, token, intent, type: "file" });
  }

  return Response.json({ error: "Unknown intent" }, { status: 400 });
};

async function createReceiveFile(sub: string, magnet: string, token?: string) {
  const created = await createEmptyFile(sub, false);
  const updated = await updateFile(sub, created.id, {
    filename: "New File",
    magnet,
    ...(token ? { token } : {}),
  });
  // A recipient shares the original token. Remove only the unused mapping
  // generated for this new record; keep the sender's token mapping intact.
  if (token && created.token && token !== created.token && await countFilesWithToken(created.token) === 0) {
    await HashMap.del(created.token);
  }
  return updated;
}
