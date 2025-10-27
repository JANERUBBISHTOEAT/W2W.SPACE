import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import invariant from "tiny-invariant";
import HashMap from "~/utils/hashmap.server";
import { getTextByToken } from "~/utils/text.server";

export const loader = async ({ params }: LoaderFunctionArgs) => {
  invariant(params.token, "Missing token param");
  const token = params.token;

  // Try to find text first
  const text = await getTextByToken(token);
  if (text) {
    return redirect(`/texts/${text.id}`);
  }

  // Try to find file by token
  const magnet = await HashMap.get(token);
  if (magnet) {
    // Find file by magnet and redirect
    return redirect(`/token/${token}`);
  }

  // If not found, redirect to home with error
  return redirect(`/?message=Invalid+Token`);
};

