import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import invariant from "tiny-invariant";
import { createEmptyFile, updateFile } from "~/utils/data.server";
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

    // Try get existing file by magnet first
    const user = await getUserSession(request);
    const visitor = await getVisitorSession(request);
    const sub = user?.sub || visitor?.sub;

    let existingFile = null;
    if (sub) {
      const { getFiles } = await import("~/utils/data.server");
      const files = await getFiles(sub);
      existingFile = files.find((f) => f.magnet === formObj.magnet);
    }

    if (existingFile && existingFile.token) {
      return json({ token: existingFile.token, magnet: formObj.magnet });
    }

    // Generate & save token (using fileId, not magnet)
    // First create a temporary file to get fileId
    const fileId = Math.random().toString(36).substring(2, 9);
    const token = await HashMap.genToken(fileId);
    console.log("Token:", token);

    let newfile;
    if (params.fileId === "new" && token)
      newfile = await createReceiveFile(
        request,
        token,
        formObj.magnet as string
      );

    return json({
      fileId: newfile?.id,
      token: token,
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
      // Search globally by fileId to find magnet (not dependent on userId)
      const { getFileByFileId } = await import("~/utils/data.server");
      fileData = await getFileByFileId(fileId);
      magnet = fileData?.magnet || null;
    }

    let newfile;
    if (params.fileId === "new" && magnet)
      newfile = await createReceiveFile(
        request,
        formObj.token as string,
        magnet
      );

    return json({
      fileId: newfile?.id,
      magnet: magnet,
      token: formObj.token,
      intent: "acquireMagnet",
      type: fileId ? "file" : null,
    });
  }
};

async function createReceiveFile(
  request: Request,
  token: string,
  magnet: string
) {
  console.log("intent: newFile");
  const user = await getUserSession(request);
  const visitor = await getVisitorSession(request);
  console.log("User:", user);
  console.log("Visitor:", visitor);

  // Create new file
  const sub = user?.sub || visitor?.sub;
  console.log("sub:", sub);
  const newFile = await createEmptyFile(sub, false);
  updateFile(sub, newFile.id, {
    filename: "New File",
    token: token,
    magnet: magnet,
  });
  return newFile;
}
