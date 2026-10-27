import { json } from "@remix-run/node";
import HashMap from "~/utils/hashmap.server";

export async function loader() {
  try {
    await HashMap.getKeysCnt();
    return json(
      { status: "ok", version: process.env.APP_REVISION || "development" },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return json(
      { status: "unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
