import { reactRouter } from "@react-router/dev/vite";
import { fileURLToPath } from "url";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";
import { config } from "dotenv";

config();
const isProduction = process.env.NODE_ENV === "production";

export default defineConfig({
  esbuild: isProduction
    ? {
        drop: ["console", "debugger"],
      }
    : {},
  plugins: [
    reactRouter(),
    tsconfigPaths(),
  ],
  resolve: {
    alias: {
      "~": "/app",
      webtorrent: fileURLToPath(
        new URL(
          "./node_modules/webtorrent/dist/webtorrent.min.js",
          import.meta.url
        )
      ),
    },
  },
  ssr: {
    external: ["crypto", "webtorrent", "../../public/webtorrent.min.js"],
  },
  optimizeDeps: {
    exclude: ["crypto", "webtorrent", "../../public/webtorrent.min.js"],
  },
});
