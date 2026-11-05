import type { ActionFunctionArgs } from "react-router";
import { createGoogleLoginChallenge } from "~/utils/google-login-challenge.server";
import { isSameSiteRequest } from "~/utils/request-origin.server";

const headers = { "Cache-Control": "no-store" };

export function loader() {
  return Response.json({ error: "Method not allowed" }, { status: 405, headers: { ...headers, Allow: "POST" } });
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405, headers: { ...headers, Allow: "POST" } });
  }
  if (!isSameSiteRequest(request)) {
    return Response.json({ error: "Login must originate from this site" }, { status: 403, headers });
  }
  if (!process.env.GOOGLE_CLIENT_ID) {
    return Response.json({ error: "Google login is not configured" }, { status: 503, headers });
  }
  try {
    return Response.json(await createGoogleLoginChallenge(request), { headers });
  } catch (error) {
    if (error instanceof Response) {
      return Response.json({ error: "Your session expired. Please reload and try again." }, { status: error.status, headers });
    }
    return Response.json({ error: "Google login is temporarily unavailable. Please try again." }, { status: 503, headers });
  }
}
