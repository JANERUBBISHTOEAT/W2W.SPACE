import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { startRedis } from "./helpers.mjs";

const execute = promisify(execFile);
const directory = fileURLToPath(new URL("..", import.meta.url));
export async function storageCases(t) {
  const redis = await startRedis();
  t.after(() => redis.stop());
  const { outputFiles } = await build({
    entryPoints: ["app/utils/share.server.ts"], absWorkingDir: directory,
    bundle: true, write: false, platform: "node", format: "cjs", packages: "external",
  });
  return async (source) => {
    const script = `
      const utilities = (() => { const module = { exports: {} }; ${outputFiles[0].text}; return module.exports; })();
      const assert = require('node:assert/strict');
      const Redis = require('ioredis');
      const redis = new Redis({ host: process.env.REDIS_HOST, port: Number(process.env.REDIS_PORT) });
      const { publishShare, getShare, accessShare, createTextShare, getTextShare, accessTextShare, editTextShare, cancelTextDraft, resolveToken, normalizeInfoHash, parseMagnet } = utilities;
      const key = (kind, id) => 'w2w:v2:share:' + kind + ':' + id;
      const tokenKey = (token) => 'w2w:v2:token:' + token;
      const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
      (async () => { try { ${source}; await redis.quit(); process.exit(0); }
        catch (error) { console.error(error); redis.disconnect(); process.exit(1); } })();
    `;
    try {
      await execute(process.execPath, ["--input-type=commonjs", "-e", script], {
        cwd: directory, env: { ...process.env, NODE_ENV: "test", REDIS_HOST: redis.host, REDIS_PORT: String(redis.port) },
        timeout: 15000, maxBuffer: 1024 * 1024,
      });
    } catch (error) { throw new Error(`Share storage regression failed:\n${error.stderr || error.message}`, { cause: error }); }
  };
}
