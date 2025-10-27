import { ActionFunctionArgs, redirect } from "@remix-run/node";
import { createEmptyText } from "~/utils/text.server";
import { getUserSession, getVisitorSession } from "~/utils/session.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const user = await getUserSession(request);
  const visitor = await getVisitorSession(request);
  const sub = user?.sub || visitor?.sub;
  const newText = await createEmptyText(sub, true);

  return redirect(`/texts/${newText.id}`);
};
