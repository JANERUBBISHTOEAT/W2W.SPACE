import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import invariant from "tiny-invariant";
import {
  createEmptyFile,
  getFile,
  updateFile,
  getFiles,
} from "~/utils/data.server";
import HashMap from "~/utils/hashmap.server";
import { getUserSession, getVisitorSession } from "~/utils/session.server";

export const action = async ({ params, request }: ActionFunctionArgs) => {
  console.log("Action params:", params);
  invariant(params.fileId, "Missing fileId param");

  // Check intent
  const formData = await request.formData();
  const formObj = Object.fromEntries(formData) as {
    intent: "acquireToken" | "acquireMagnet";
    magnet?: string;
    token?: string;
  };
  console.log("formObj:", formObj);

  // [x] Add new file record if fileId="new"
  // Need to return both magnet and token

  // * Acquire token
  if (formObj.intent === "acquireToken") {
    console.log("intent: acquireToken");
    // No magnet provided, return
    if (!formObj.magnet) {
      return json({
        token: "",
        magnet: formObj.magnet,
        intent: "acquireToken",
      });
    }

    const user = await getUserSession(request);
    const visitor = await getVisitorSession(request);
    const sub = user?.sub || visitor?.sub;

    // Existing file (edit page seed): token was created at file creation, only return it.
    if (params.fileId !== "new" && sub) {
      const file = await getFile(sub, params.fileId);
      if (file?.token) {
        return json({
          fileId: file.id,
          token: file.token,
          magnet: formObj.magnet,
          intent: "acquireToken",
        });
      }
    }

    // New receive (homepage paste magnet): try existing by magnet, else create one file (token only at create).
    if (params.fileId === "new" && sub) {
      const files = await getFiles(sub);
      const existingFile = files.find((f) => f.magnet === formObj.magnet);
      if (existingFile?.token) {
        return json({
          token: existingFile.token,
          magnet: formObj.magnet,
          intent: "acquireToken",
        });
      }
      const newfile = await createReceiveFile(
        request,
        formObj.magnet as string,
      );
      return json({
        fileId: newfile.id,
        token: newfile.token ?? "",
        magnet: formObj.magnet,
        intent: "acquireToken",
      });
    }

    return json({
      token: "",
      magnet: formObj.magnet,
      intent: "acquireToken",
    });
  }

  // * Acquire magnet
  if (formObj.intent === "acquireMagnet") {
    console.log("intent: acquireMagnet");
    // No token provided, return
    if (!formObj.token) {
      return json({ magnet: "" });
    }

    const token = formObj.token as string;

    // Check if it's a text token first
    const textId = await HashMap.getText(token);
    if (textId) {
      return json({
        intent: "acquireMagnet",
        textId: textId,
        magnet: null,
        type: "text",
      });
    }

    // Otherwise try file token
    const fileId = await HashMap.getFile(token);

    // Get file record to retrieve magnet
    let magnet = null;
    let fileData = null;
    if (fileId) {
      const { getFileByFileId } = await import("~/utils/data.server");
      fileData = await getFileByFileId(fileId);
      magnet = fileData?.magnet || null;
    }

    let newfile;
    if (params.fileId === "new" && magnet) {
      const user = await getUserSession(request);
      const visitor = await getVisitorSession(request);
      const sub = user?.sub || visitor?.sub;
      // Downloader already has a file with this token → reuse it, don't create duplicate empty "New File"
      if (sub) {
        const { getFiles } = await import("~/utils/data.server");
        const files = await getFiles(sub);
        const existing = files.find((f) => f.token === token);
        if (existing) {
          newfile = existing;
        }
      }
      if (!newfile) {
        newfile = await createReceiveFile(
          request,
          magnet,
          formObj.token as string,
        );
      }
    }

    return json({
      fileId: newfile?.id,
      magnet: magnet,
      token: formObj.token,
      intent: "acquireMagnet",
      type: fileId ? "file" : null,
    });
  }
};

/**
 * Create a new file for receiving.
 * Token: when assignToken is omitted, use token from createEmptyFile (only place we generate).
 * When assignToken is set (acquireMagnet flow), assign that token to the new file.
 */
async function createReceiveFile(
  request: Request,
  magnet: string,
  assignToken?: string,
) {
  const user = await getUserSession(request);
  const visitor = await getVisitorSession(request);
  const sub = user?.sub || visitor?.sub;
  if (!sub) throw new Response("Unauthorized", { status: 401 });

  const newFile = await createEmptyFile(sub, false);
  await updateFile(sub, newFile.id, {
    filename: "New File",
    magnet: magnet,
    ...(assignToken != null && assignToken !== "" && { token: assignToken }),
  });
  return newFile;
}
