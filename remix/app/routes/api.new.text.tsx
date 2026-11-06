import { redirect } from "react-router";
import { createEmptyText } from "~/utils/text.server";

export const action = async () => {
  const text = await createEmptyText();
  return redirect(`/texts/${text.id}`);
};
