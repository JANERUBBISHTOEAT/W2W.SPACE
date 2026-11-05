// The router also checks scheme after trusted proxy normalization. Host matching
// here preserves HTTPS deployments whose immediate upstream connection is HTTP.
export function isSameSiteRequest(request: Request): boolean {
  if (request.headers.get("Sec-Fetch-Site") === "cross-site") return false;
  const origin = request.headers.get("Origin");
  if (!origin) return false;
  try {
    const url = new URL(origin);
    return (url.protocol === "http:" || url.protocol === "https:") &&
      url.host === new URL(request.url).host;
  } catch {
    return false;
  }
}
