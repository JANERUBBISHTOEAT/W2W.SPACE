import { checkShareStorage } from "~/utils/share.server";

export async function loader() {
  try {
    await checkShareStorage();
    return Response.json(
      { status: "ok", version: process.env.APP_REVISION || "development" },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json(
      { status: "unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
