import { ActionFunctionArgs, redirect } from "@remix-run/node";
import { createEmptyText } from "~/utils/text.server";
import { requireSessionIdentity } from "~/utils/session.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { sub } = await requireSessionIdentity(request);
  const newText = await createEmptyText(sub, true);

  return redirect(`/texts/${newText.id}`);
};
