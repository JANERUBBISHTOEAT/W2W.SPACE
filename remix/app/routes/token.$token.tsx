import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import invariant from "tiny-invariant";
import HashMap from "~/utils/hashmap.server";

export const loader = async ({ params }: LoaderFunctionArgs) => {
  invariant(params.token, "Missing token param");
  const token = params.token;

  // Check unified token map
  const result = await HashMap.getBoth(token);

  if (result.type === "text" && result.textId) {
    // Token exists as text, redirect to text
    return redirect(`/texts/${result.textId}`);
  }

  if (result.type === "file" && result.magnet) {
    // Token exists as file, redirect to file via token
    return redirect(`/token/${token}`);
  }

  // If not found, redirect to home with error
  return redirect(`/?message=Invalid+Token`);
};
