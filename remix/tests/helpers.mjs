import { spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const appDirectory = fileURLToPath(new URL("../", import.meta.url));

// Remix 2.17.5 server-runtime/cookies + @remix-run/node cookie-signature format.
// This implementation is intentionally independent of the new router's signer.
function legacySessionCookie(data, secret) {
  const value = Buffer.from(JSON.stringify(data), "utf8").toString("base64");
  const signature = createHmac("sha256", secret).update(value).digest("base64").replace(/=+$/, "");
  return `session=${encodeURIComponent(`${value}.${signature}`)}`;
}

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

function startProcess(command, args, options, secrets = []) {
  const child = spawn(command, args, {
    ...options,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let spawnError;
  const capture = (chunk) => {
    output = (output + chunk.toString()).slice(-12000);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  child.once("error", (error) => { spawnError = error; });
  let closed = false;
  const completion = new Promise((resolve) => {
    child.once("close", () => { closed = true; resolve(); });
  });
  let stopping;
  const diagnostics = () => {
    let safeOutput = output;
    for (const secret of secrets) safeOutput = safeOutput.replaceAll(secret, "[redacted]");
    return safeOutput;
  };
  return {
    diagnostics,
    failure() {
      if (spawnError) return spawnError;
      if (closed) {
        return new Error(`Process exited (${child.exitCode ?? child.signalCode}): ${diagnostics()}`);
      }
      return null;
    },
    stop() {
      if (!stopping) {
        stopping = (async () => {
          if (closed) return;
          child.kill("SIGTERM");
          const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
          try { await completion; } finally { clearTimeout(timer); }
        })();
      }
      return stopping;
    },
  };
}

async function waitFor(check, process, label, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    const failure = process.failure();
    if (failure) throw failure;
    try {
      await check();
      return;
    } catch (error) { lastError = error; }
    await delay(100);
  }
  throw new Error(`${label} was not ready within ${timeout} ms`, { cause: lastError });
}

function redisPing(host, port) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port });
    let response = "";
    const finish = (error) => {
      socket.destroy();
      if (error) reject(error); else resolve();
    };
    socket.setTimeout(500, () => finish(new Error("Redis PING timed out")));
    socket.once("error", reject);
    socket.once("connect", () => socket.write("*1\r\n$4\r\nPING\r\n"));
    socket.on("data", (chunk) => {
      response += chunk.toString();
      if (response.includes("\r\n")) {
        finish(response === "+PONG\r\n" ? null : new Error("Unexpected Redis PING response"));
      }
    });
  });
}

/** Every caller owns a separate Redis process and data directory. */
export async function startRedis() {
  const directory = await mkdtemp(join(tmpdir(), "w2w-test-redis-"));
  const host = "127.0.0.1";
  let process;
  let stopping;
  const stop = () => {
    stopping ??= (async () => {
      if (process) await process.stop();
      await rm(directory, { recursive: true, force: true });
    })();
    return stopping;
  };
  try {
    const port = await unusedPort();
    process = startProcess(globalThis.process.env.REDIS_SERVER || "redis-server", [
      "--bind", host, "--port", String(port), "--protected-mode", "yes",
      "--dir", directory, "--save", "", "--appendonly", "no", "--daemonize", "no",
    ]);
    await waitFor(() => redisPing(host, port), process, "Isolated Redis");
    return { host, port, directory, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

/** Starts the built production application against its own disposable Redis. */
export async function startApplication({ trustedProxyCIDRs = "", nodeImports = [] } = {}) {
  await access(join(appDirectory, "build/server/index.js"));
  const redis = await startRedis();
  const sessionSecret = randomBytes(32).toString("hex");
  let process;
  let stopping;
  const stop = () => {
    stopping ??= (async () => {
      if (process) await process.stop();
      await redis.stop();
    })();
    return stopping;
  };
  try {
    const port = await unusedPort();
    const baseURL = `http://127.0.0.1:${port}`;
    process = startProcess(globalThis.process.execPath, [
      // Test-owned preloads may replace external certificate retrieval without
      // introducing a token-acceptance hook into the application itself.
      ...nodeImports.flatMap((specifier) => ["--import", specifier]),
      join(appDirectory, "server.mjs"),
    ], {
      cwd: appDirectory,
      env: {
        ...globalThis.process.env,
        NODE_ENV: "production",
        HOST: "127.0.0.1",
        PORT: String(port),
        REDIS_HOST: redis.host,
        REDIS_PORT: String(redis.port),
        SESSION_SECRET: sessionSecret,
        GOOGLE_CLIENT_ID: "w2w-integration-test.apps.googleusercontent.com",
        APP_REVISION: "test-revision",
        TRUSTED_PROXY_CIDRS: trustedProxyCIDRs,
      },
    }, [sessionSecret]);
    await waitFor(async () => {
      const response = await fetch(baseURL + "/health", { signal: AbortSignal.timeout(1000) });
      const health = await response.json();
      if (response.status !== 200 || health.status !== "ok" || health.version !== "test-revision") {
        throw new Error(`Application readiness returned HTTP ${response.status}`);
      }
    }, process, "Production application");
    return {
      baseURL,
      redis,
      stop,
      diagnostics: process.diagnostics,
      legacySessionCookie: (data) => legacySessionCookie(data, sessionSecret),
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

/** A manual cookie jar lets these local HTTP tests use production Secure cookies. */
export function createClient(baseURL, initialCookie) {
  let cookie = initialCookie;
  return async (path, form, headers = {}) => {
    const response = await fetch(baseURL + path, {
      method: form ? "POST" : "GET",
      redirect: "manual",
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: form ? new URLSearchParams(form) : undefined,
      signal: AbortSignal.timeout(10000),
    });
    const nextCookie = response.headers.get("set-cookie");
    if (nextCookie) cookie = nextCookie.split(";")[0];
    return response;
  };
}
