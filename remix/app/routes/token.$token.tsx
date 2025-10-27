import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import invariant from "tiny-invariant";
import HashMap from "~/utils/hashmap.server";

export const loader = async ({ params }: LoaderFunctionArgs) => {
  invariant(params.token, "Missing token param");
  const token = params.token;

  // Check both textTokenMap and tokenMap simultaneously
  const [textId, magnet] = await Promise.all([
    HashMap.getText(token),
    HashMap.get(token),
  ]);

  if (textId) {
    // Token exists in textTokenMap, redirect to text
    return redirect(`/texts/${textId}`);
  }

  if (magnet) {
    // Token exists in tokenMap, it's a file token
    return redirect(`/token/${token}`);
  }

  // If not found in either map, redirect to home with error
  return redirect(`/?message=Invalid+Token`);
};
