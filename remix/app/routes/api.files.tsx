import { type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import { accessShare, getShare, publishShare, ShareValidationError } from "~/utils/share.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const shareId = new URL(request.url).searchParams.get("shareId");
  const share = shareId ? await getShare(shareId) : null;
  return Response.json({ share }, { status: share ? 200 : 404, headers: { "Cache-Control": "no-store" } });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const form = await request.formData();
  if (form.get("intent") === "access") {
    const id = form.get("shareId");
    const share = typeof id === "string" ? await accessShare(id) : null;
    return Response.json({ share }, { status: share ? 200 : 404 });
  }
  if (form.get("intent") !== "publish" && form.get("intent") !== "updateFile") {
    return Response.json({ error: "Unknown intent" }, { status: 400 });
  }
  try {
    const magnet = form.get("magnet");
    if (typeof magnet !== "string") throw new ShareValidationError("A valid magnet link is required");
    const string = (key: string) => typeof form.get(key) === "string" ? form.get(key) as string : undefined;
    const size = string("filesize");
    // Publishing the same hash returns the existing immutable originals.
    // Client-supplied IDs, tokens and all personal fields are never persisted.
    const share = await publishShare({ magnet, filename: string("filename"), type: string("filetype"), size: size === undefined ? undefined : Number(size) });
    return Response.json({ share, file: share, shareId: share.id, fileId: share.id, token: share.token });
  } catch (error) {
    if (error instanceof ShareValidationError) return Response.json({ error: error.message }, { status: 400 });
    throw error;
  }
};
