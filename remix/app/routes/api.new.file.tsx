import { ActionFunctionArgs, redirect } from "@remix-run/node";
import { createEmptyFile } from "~/utils/data.server";
import { requireSessionIdentity } from "~/utils/session.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { sub } = await requireSessionIdentity(request);
  const newFile = await createEmptyFile(sub, false);
  const formData = await request.formData();

  return redirect(
    `/files/${newFile.id}/edit` +
      `?pasted=true` +
      `&fileName=${formData.get("fileName")}` +
      `&mimeType=${formData.get("mimeType")}`
  );
};
