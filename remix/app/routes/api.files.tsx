import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { getFile, updateFile } from "~/utils/data.server";
import { getUserSession, getVisitorSession } from "~/utils/session.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  // Check intent
  const formData = await request.formData();
  const formObj = Object.fromEntries(formData) as unknown as {
    intent: "updateFile";
    fileid: string;
    magnet?: string;
    filename?: string;
    filesize?: number;
    filetype?: string;
  };
  console.log("formObj:", formObj);

  //  Update file
  const user = await getUserSession(request);
  const visitor = await getVisitorSession(request);
  const sub = user?.sub || visitor?.sub;

  // Check if file exists
  const file = await getFile(sub, formObj.fileid);
  if (!file) {
    return json({ error: "File not found" }, { status: 404 });
  }

  // Update file (may merge into existing when duplicate magnet+filename)
  const updatedFile = await updateFile(
    sub,
    formObj.fileid,
    {
      magnet: formObj.magnet,
      filename: formObj.filename,
      size: formObj.filesize,
      type: formObj.filetype,
    },
    false, // not force update
    true, // allow delete when duplicate
  );

  // Duplicate merged: current file was removed; return redirect URL so client can navigate (fetcher does not follow redirect with full page load, so message would not show)
  if (updatedFile.id !== formObj.fileid) {
    const message = encodeURIComponent("Existing file found");
    return json({
      redirect: true,
      url: `/files/${updatedFile.id}/edit?message=${message}`,
    });
  }

  return json({ file: updatedFile });
};
