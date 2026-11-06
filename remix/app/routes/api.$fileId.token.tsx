import { type ActionFunctionArgs } from "react-router";
import { publishShare, resolveToken, ShareValidationError } from "~/utils/share.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const form = await request.formData();
  const intent = form.get("intent");
  try {
    if (intent === "acquireToken") {
      const magnet = form.get("magnet");
      if (typeof magnet !== "string") throw new ShareValidationError("A valid magnet link is required");
      const string = (key: string) => typeof form.get(key) === "string" ? form.get(key) as string : undefined;
      const size = string("filesize");
      const share = await publishShare({ magnet, filename: string("filename"), type: string("filetype"), size: size === undefined ? undefined : Number(size) });
      return Response.json({ intent, type: "file", share, shareId: share.id, fileId: share.id, token: share.token, magnet: share.magnet });
    }
    if (intent === "acquireMagnet") {
      const token = form.get("token");
      if (typeof token !== "string" || !/^\d{6}$/.test(token)) throw new ShareValidationError("A six-digit token is required");
      const result = await resolveToken(token, true);
      if (!result) return Response.json({ intent, type: null, magnet: null, token });
      if (result.type === "text") return Response.json({ intent, type: "text", textId: result.share.id, magnet: null, token });
      const { share } = result;
      return Response.json({ intent, type: "file", share, shareId: share.id, fileId: share.id, token, magnet: share.magnet });
    }
    return Response.json({ error: "Unknown intent" }, { status: 400 });
  } catch (error) {
    if (error instanceof ShareValidationError) return Response.json({ error: error.message }, { status: 400 });
    throw error;
  }
};
