import { type ActionFunctionArgs } from "react-router";
import { action as publish } from "./api.files";

// Drafts are browser-local. The server only accepts a complete magnet identity.
export const action = async ({ request, ...args }: ActionFunctionArgs) => {
  const form = await request.formData();
  form.set("intent", "publish");
  return publish({ ...args, request: new Request(request.url, { method: "POST", body: form }) });
};
