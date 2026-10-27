import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import invariant from "tiny-invariant";
import HashMap from "~/utils/hashmap.server";

export const loader = async ({ params }: LoaderFunctionArgs) => {
  invariant(params.token, "Missing token param");
  const result = await HashMap.getBoth(params.token);
  if (result.status === "deleted") return redirect("/deleted");
  if (result.type === "text" && result.textId) {
    return redirect(`/texts/${result.textId}`);
  }
  if (result.type === "file" && result.fileId) {
    // The home page resolves the token and starts receiving the shared file.
    return redirect(`/?token=${encodeURIComponent(params.token)}`);
  }
  return redirect("/?message=Invalid+Token");
};
