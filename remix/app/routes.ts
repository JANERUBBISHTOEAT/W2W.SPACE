import type { RouteConfig } from "@react-router/dev/routes";
import { flatRoutes } from "@react-router/fs-routes";

// Retain the existing file-based URLs and route IDs for all shared links.
export default flatRoutes({ ignoredRouteFiles: ["**/*.css"] }) satisfies RouteConfig;
