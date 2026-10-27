import { type ActionFunctionArgs } from "react-router";
import { getFile, updateFile } from "~/utils/data.server";
import { requireSessionIdentity } from "~/utils/session.server";
import { FIELD_MAX_SIZE } from "~/utils/constants";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { sub } = await requireSessionIdentity(request);
  const formData = await request.formData();
  const fileId = formData.get("fileid");
  if (typeof fileId !== "string" || !fileId) {
    return Response.json({ error: "fileid is required" }, { status: 400 });
  }
  const readString = (name: string) => {
    const value = formData.get(name);
    return typeof value === "string" ? value : undefined;
  };
  const filename = readString("filename");
  const magnet = readString("magnet");
  const filetype = readString("filetype");
  const sizeValue = readString("filesize");
  const size = sizeValue === undefined ? undefined : Number(sizeValue);
  if ((size !== undefined && (!Number.isSafeInteger(size) || size < 0)) ||
      [filename, magnet, filetype].some((value) => value !== undefined && Buffer.byteLength(value) > FIELD_MAX_SIZE)) {
    return Response.json({ error: "Invalid file metadata" }, { status: 400 });
  }

  // Check if file exists
  const file = await getFile(sub, fileId);
  if (!file) {
    return Response.json({ error: "File not found" }, { status: 404 });
  }

  // Update file (may merge into existing when duplicate magnet+filename)
  const updatedFile = await updateFile(
    sub,
    fileId,
    {
      ...(magnet !== undefined && { magnet }),
      ...(filename !== undefined && { filename }),
      ...(size !== undefined && { size }),
      ...(filetype !== undefined && { type: filetype }),
    },
    false, // not force update
    true, // allow delete when duplicate
  );

  // Duplicate merged: current file was removed; return redirect URL so client can navigate (fetcher does not follow redirect with full page load, so message would not show)
  if (updatedFile.id !== fileId) {
    const message = encodeURIComponent("Existing file found");
    return Response.json({
      redirect: true,
      url: `/files/${updatedFile.id}/edit?message=${message}`,
    });
  }

  return Response.json({ file: updatedFile });
};
