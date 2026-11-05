import { index, route, type RouteConfig } from "@react-router/dev/routes";

// Keep the existing URLs, route IDs, and root-level hierarchy. Explicit routes
// avoid fs-routes' dependency on minimatch's removed regular-expression API.
export default [
  route("files/:fileId/destroy", "routes/files.$fileId_.destroy.tsx"),
  route("files/:fileId/edit", "routes/files.$fileId_.edit.tsx"),
  route("api/:fileId/token", "routes/api.$fileId.token.tsx"),
  route("files/:fileId", "routes/files.$fileId.tsx"),
  route("texts/:textId", "routes/texts.$textId.tsx"),
  route("api/new/file", "routes/api.new.file.tsx"),
  route("api/new/text", "routes/api.new.text.tsx"),
  route("token/:token", "routes/token.$token.tsx"),
  route("api/restore", "routes/api.restore.tsx"),
  route("api/auth/google/challenge", "routes/api.auth.google.challenge.ts"),
  route("text-editor", "routes/text-editor.tsx"),
  route("api/files", "routes/api.files.tsx"),
  route("deleted", "routes/deleted.tsx"),
  index("routes/_index.tsx"),
  route("health", "routes/health.ts"),
  route("new", "routes/new.tsx"),
  route("*", "routes/$.tsx"),
] satisfies RouteConfig;
