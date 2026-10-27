import "dotenv/config";
import { BlockList, isIP } from "node:net";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath } from "node:url";
import { createRequestHandler } from "@react-router/express";
import express from "express";
import proxyaddr from "proxy-addr";

process.env.NODE_ENV ??= "production";

const mappedIPv4 = new BlockList();
mappedIPv4.addSubnet("::ffff:0:0", 96, "ipv6");

function trustedProxyAddresses(raw = "") {
  if (!raw.trim()) return [];
  return raw.split(",").map((entry, index) => {
    const value = entry.trim();
    const [address, prefix, extra] = value.split("/");
    const family = isIP(address);
    const maxPrefix = family === 4 ? 32 : 128;
    const invalidPrefix = prefix !== undefined && (
      !/^\d+$/.test(prefix) || Number(prefix) < 1 || Number(prefix) > maxPrefix ||
      (family === 6 && mappedIPv4.check(address, "ipv6") && Number(prefix) <= 96)
    );
    // proxy-addr also accepts aliases such as "loopback"; configuration here
    // deliberately accepts only explicit addresses and bounded CIDR ranges.
    if (!family || address.includes("%") || extra !== undefined || invalidPrefix) {
      throw new Error(`TRUSTED_PROXY_CIDRS entry ${index + 1} must be a literal IP or nonzero CIDR`);
    }
    return value;
  });
}

const proxies = trustedProxyAddresses(process.env.TRUSTED_PROXY_CIDRS);
const isTrustedProxy = proxies.length ? proxyaddr.compile(proxies) : () => false;
const rawPort = process.env.PORT ?? "3000";
const port = Number(rawPort);
if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}
const host = process.env.HOST || "0.0.0.0";
const build = await import("./build/server/index.js");
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", proxies.length ? isTrustedProxy : false);

app.use((request, _response, next) => {
  if (!request.socket.remoteAddress || !isTrustedProxy(request.socket.remoteAddress)) {
    // The adapter reads X-Forwarded-Host's port when trust proxy is configured,
    // even for an untrusted peer. Remove every forwarded header before it runs.
    for (const name of Object.keys(request.headers)) {
      if (name === "forwarded" || name.startsWith("x-forwarded-")) {
        delete request.headers[name];
      }
    }
  }
  next();
});

app.use((request, response, next) => {
  const started = process.hrtime.bigint();
  response.once("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
    const length = response.getHeader("Content-Length") ?? "-";
    // Shared-link tokens, credentials and search text can occur in URLs or
    // bodies, so access logs contain only request/response metadata.
    console.info(`[w2w] ${request.method} ${response.statusCode} ${length} ${durationMs.toFixed(1)}ms`);
  });
  next();
});

app.use("/assets", express.static(fileURLToPath(new URL("./build/client/assets/", import.meta.url)), {
  immutable: true,
  maxAge: "1y",
}));
app.use(express.static(fileURLToPath(new URL("./build/client/", import.meta.url)), { maxAge: "1h" }));
app.use(express.static(fileURLToPath(new URL("./public/", import.meta.url)), { maxAge: "1h" }));
// Keep the request body untouched for React Router's streaming/form handling.
app.use(createRequestHandler({ build, mode: process.env.NODE_ENV }));

const server = app.listen(port, host, () => {
  console.info(`[w2w] Listening on port ${port}; ${proxies.length} trusted proxy entries`);
});
server.on("error", (error) => {
  console.error(`[w2w] HTTP server failed: ${error.code ?? "unknown error"}`);
  process.exit(1);
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const deadline = setTimeout(() => {
    console.error("[w2w] HTTP shutdown exceeded 10 seconds");
    server.closeAllConnections();
    process.exit(1);
  }, 10_000);
  deadline.unref();
  server.close((error) => {
    clearTimeout(deadline);
    // The application owns background Redis connections and cleanup timers.
    // Exit only after active HTTP responses finish, or the deadline expires.
    process.exit(error ? 1 : 0);
  });
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
