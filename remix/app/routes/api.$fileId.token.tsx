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

    // Try get magnet first
    const magnet = await HashMap.get(formObj.magnet as string);
    if (magnet) {
      return json({ token: magnet, magnet: formObj.magnet });
    }

    // Generate & save token
    const token = await HashMap.genToken(formObj.magnet as string);
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
    const magnet = await HashMap.get(token);

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
      type: magnet ? "file" : null,
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
