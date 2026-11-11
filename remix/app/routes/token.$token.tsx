import { type LoaderFunctionArgs, redirect } from "react-router";
import { resolveToken } from "~/utils/share.server";

export const loader = async ({ params }: LoaderFunctionArgs) => {
  const token = params.token ?? "";
  const result = await resolveToken(token);
  if (result?.type === "text") return redirect(`/texts/${result.share.id}`);
  if (result?.type === "file") {
    // The home page resolves the token and starts receiving the shared file.
    return redirect(`/?token=${encodeURIComponent(token)}`);
  }
  return redirect("/?message=Invalid+Token");
};
