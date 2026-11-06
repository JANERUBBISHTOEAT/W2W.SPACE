import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Redis from "ioredis";
import { createRequire } from "node:module";
import test from "node:test";
import {
  UNSAFE_decodeViaTurboStream,
  UNSAFE_SingleFetchRedirectSymbol,
} from "react-router";
import { createClient, startApplication } from "./helpers.mjs";

const require = createRequire(import.meta.url);
const textRoute = "routes/texts.$textId";
const dataPath = (path, route) => `${path === "/" ? "/_root" : path}.data?_routes=${encodeURIComponent(route)}`;

async function decodeStream(response) {
  assert.match(response.headers.get("content-type") ?? "", /text\/x-script/);
  const { value } = await UNSAFE_decodeViaTurboStream(response.body, globalThis);
  return value;
}

async function decodeData(response, route) {
  const value = await decodeStream(response);
  const result = route ? value[route] : value;
  assert(result && typeof result === "object", "Expected a router data result");
  if (result.error) throw result.error;
  assert("data" in result, "Expected route data, not an error or redirect");
  return result.data;
}

async function visitor(baseURL) {
  const request = createClient(baseURL);
  const response = await request("/");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie") ?? "", /HttpOnly/i);
  assert.match(response.headers.get("set-cookie") ?? "", /Secure/i);
  assert.match(await response.text(), /id="sidebar"/);
  return request;
}

async function createText(request) {
  const response = await request("/api/new/text", {});
  assert.equal(response.status, 302);
  const path = response.headers.get("location");
  assert.match(path, /^\/texts\/[^/?]+$/);
  return { path, id: path.split("/").pop(), data: dataPath(path, textRoute) };
}

async function readText(request, path) {
  const response = await request(path);
  assert.equal(response.status, 200);
  return (await decodeData(response, textRoute)).text;
}

test("production HTTP workflows and anonymous shares", { timeout: 60000 }, async (t) => {
  const app = await startApplication();
  t.after(app.stop);
  const redis = new Redis({ host: app.redis.host, port: app.redis.port });
  t.after(() => redis.quit());

  await t.test("health reports the intended revision on the patched router runtime", async () => {
    const response = await createClient(app.baseURL)("/health");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("set-cookie"), null);
    assert.deepEqual(await response.json(), { status: "ok", version: "test-revision" });
    const { version } = JSON.parse(await readFile(require.resolve("react-router/package.json"), "utf8"));
    const [major, minor, patch] = version.split(".").map(Number);
    assert.equal(major, 7);
    assert(minor > 18 || (minor === 18 && patch >= 4), "React Router must include the 7.18.4 security fixes");
  });

  await t.test("home renders the Pages help link and canonical source repository", async () => {
    const response = await createClient(app.baseURL)("/");
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /href="https:\/\/janerubbishtoeat\.github\.io\/W2W\.SPACE\/#why-w2w">\| Why W2W\?<\/a>/);
    assert.match(html, /href="https:\/\/github\.com\/JANERUBBISHTOEAT\/W2W\.SPACE">\| View on GitHub<\/a>/);
    assert.ok(!html.includes("CSCC09-24F-Project"), "The footer must not use the old repository path");
  });


  await t.test("sharing requires no session while optional login retains signed cookies", async () => {
    const request = createClient(app.baseURL);
    const text = await createText(request);
    assert.equal((await readText(request, text.data)).id, text.id);
    const publish = await request("/api/new/token", { intent: "acquireToken", magnet: "magnet:?xt=urn:btih:" + "1".repeat(40) });
    assert.equal(publish.status, 200);
    const share = (await publish.json()).share;
    assert.equal(share.id, "1".repeat(40));
    const cookie = app.legacySessionCookie({ visitor: { sub: "legacy-remix2-visitor" } });
    assert.equal((await createClient(app.baseURL, cookie)("/")).headers.get("set-cookie"), null);
    assert.match((await createClient(app.baseURL, cookie + "tampered")("/")).headers.get("set-cookie") ?? "", /HttpOnly/);
    await visitor(app.baseURL);
    assert.deepEqual(await redis.keys("user:*"), []);
  });

  await t.test("draft creation creates no server file or provisional token", async () => {
    const request = createClient(app.baseURL);
    const before = (await redis.keys("w2w:v2:*")).sort();
    assert.equal((await request("/api/new/file", { fileName: "draft.txt", mimeType: "text/plain" })).status, 400);
    assert.equal((await request("/new", { type: "file" })).status, 302);
    assert.deepEqual((await redis.keys("w2w:v2:*")).sort(), before);
  });

  await t.test("anonymous publishers share canonical identity and immutable originals", async () => {
    const first = createClient(app.baseURL);
    const second = createClient(app.baseURL);
    const hash = "a".repeat(40);
    let response = await first("/api/new/token", { intent: "acquireToken", magnet: `magnet:?xt=urn:btih:${hash}&dn=original.txt`, filename: "original.txt", filesize: "12", filetype: "text/plain" });
    assert.equal(response.status, 200);
    const created = await response.json();
    response = await second("/api/new/token", { intent: "acquireToken", magnet: `magnet:?dn=changed.txt&xt=urn:btih:${hash.toUpperCase()}&tr=wss%3A%2F%2Ftracker.example`, filename: "changed.txt", filesize: "99", notes: "PRIVATE", favorite: "true", owner: "true", token: "000000" });
    const duplicate = await response.json();
    assert.equal(duplicate.shareId, hash);
    assert.equal(duplicate.token, created.token);
    assert.match(created.token, /^\d{6}$/);
    assert.equal(duplicate.share.filename, "original.txt");
    assert.equal(duplicate.share.size, 12);
    assert.equal(duplicate.share.magnet, created.share.magnet);
    const stored = JSON.parse(await redis.get(`w2w:v2:share:file:${hash}`));
    for (const name of ["notes", "favorite", "owner", "displayName", "userId"]) assert.equal(name in stored, false);
    const received = await (await second("/api/new/token", { intent: "acquireMagnet", token: created.token })).json();
    assert.equal(received.fileId, hash);
    assert.equal(received.magnet, created.magnet);
    response = await second(`/token/${created.token}`);
    assert.equal(response.headers.get("location"), `/?token=${created.token}`);
    assert.equal((await second(`/files/${hash}/destroy`, {})).status, 405);
    assert.equal((await second("/api/restore", { undoId: hash, undoType: "file" })).status, 410);
    assert.equal((await (await first(`/api/files?shareId=${hash}`)).json()).share.id, hash);
  });

  await t.test("metadata polling and router preload do not renew, active access does", async () => {
    const request = createClient(app.baseURL);
    const created = await (await request("/api/new/token", { intent: "acquireToken", magnet: "magnet:?xt=urn:btih:" + "b".repeat(40) })).json();
    const key = `w2w:v2:share:file:${created.shareId}`;
    await redis.pexpire(key, 10000);
    await redis.pexpire(`w2w:v2:token:${created.token}`, 10000);
    const before = await redis.pttl(key);
    await request(`/api/files?shareId=${created.shareId}`);
    await request(`/files/${created.shareId}`, undefined, { Purpose: "prefetch" });
    await request(dataPath("/", "root"));
    assert((await redis.pttl(key)) <= before);
    assert.equal((await request("/api/files", { intent: "access", shareId: created.shareId })).status, 200);
    assert((await redis.pttl(key)) > 29 * 86400 * 1000);
    await redis.del(key, `w2w:v2:token:${created.token}`);
    assert.equal((await request("/api/files", { intent: "access", shareId: created.shareId })).status, 404);
    assert.equal((await request(`/api/files?shareId=${created.shareId}`)).status, 404);
    assert.equal(await redis.exists(key), 0);
  });

  await t.test("text is one bearer-editable share with stable ID and no personal fields", async () => {
    const first = createClient(app.baseURL);
    const second = createClient(app.baseURL);
    const text = await createText(first);
    const created = await readText(second, text.data);
    assert.deepEqual(Object.keys(created).sort(), ["content", "id", "lastAccessedAt", "token"]);
    let response = await second(text.data, { intent: "save", content: "共享文本 ✓", title: "private title", language: "python", favorite: "true", updateCount: "900" });
    assert.equal(response.status, 200);
    assert.equal((await decodeData(response)).success, true);
    let saved = await readText(first, text.data);
    assert.equal(saved.content, "共享文本 ✓");
    assert.equal(saved.id, created.id);
    assert.equal(saved.token, created.token);
    assert.equal(saved.title, undefined);
    response = await first(`/token/${created.token}`);
    assert.equal(response.headers.get("location"), text.path);
    response = await first(dataPath(`/token/${created.token}`, "routes/token.$token"));
    assert.equal(response.status, 202);
    assert.equal((await decodeStream(response))[UNSAFE_SingleFetchRedirectSymbol].redirect, text.path);
    response = await second(text.data, { intent: "save", content: "" });
    assert.equal((await decodeData(response)).success, true);
    saved = await readText(first, text.data);
    assert.equal(saved.content, "");
    assert.equal((await first(text.path, { intent: "delete" })).status, 400);
    const key = `w2w:v2:share:text:${text.id}`;
    await redis.pexpire(key, 10000);
    const before = await redis.pttl(key);
    await readText(first, text.data);
    assert((await redis.pttl(key)) <= before);
    assert.equal((await second(text.path, { intent: "access" })).status, 200);
    assert((await redis.pttl(key)) > 29 * 86400 * 1000);
    await redis.del(key);
    assert.equal((await second(text.path, { intent: "save", content: "stale" })).status, 404);
    assert.equal(await redis.exists(key), 0);
    assert.deepEqual(await redis.keys("user:*"), []);
  });

  await t.test("malformed identities and unsafe metadata are rejected", async () => {
    const request = createClient(app.baseURL);
    for (const magnet of ["https://example.com", "magnet:?xt=urn:btih:no", `magnet:?xt=urn:btih:${"c".repeat(40)}&xt=urn:btih:${"d".repeat(40)}`]) {
      assert.equal((await request("/api/new/token", { intent: "acquireToken", magnet })).status, 400);
    }
    assert.equal((await request("/api/new/token", { intent: "acquireMagnet", token: "123" })).status, 400);
    const missing = await request("/api/new/token", { intent: "acquireMagnet", token: "000000" });
    assert.equal(missing.status, 200);
    assert.equal((await missing.json()).type, null);
    assert.equal((await request("/api/new/token", { intent: "acquireToken", magnet: "magnet:?xt=urn:btih:" + "e".repeat(40), filesize: "-1" })).status, 400);
    const text = await createText(request);
    assert.equal((await request(text.path, { intent: "save" })).status, 400);
  });

  await t.test("an unsigned Google credential cannot establish a signed-in session", async () => {
    const request = await visitor(app.baseURL);
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const credential = `${encode({ alg: "none", typ: "JWT" })}.${encode({
      sub: "forged-user", aud: "w2w-integration-test.apps.googleusercontent.com",
      iss: "https://accounts.google.com", exp: Math.floor(Date.now() / 1000) + 3600,
    })}.unsigned`;
    const response = await request("/?index", { intent: "OAuthCallback", credential }, { Origin: app.baseURL });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("set-cookie"), null);
    const state = await request(dataPath("/", "routes/_index"));
    assert.equal(state.status, 200);
    assert.equal((await decodeData(state, "routes/_index")).user, null);
  });

  await t.test("Google login rejects missing, opaque and cross-origin requests", async () => {
    const request = await visitor(app.baseURL);
    const form = { intent: "OAuthCallback", credential: "not-a-jwt" };
    for (const [headers, expectedStatus] of [
      [{}, 403],
      [{ Origin: "null" }, 400],
      [{ Origin: "https://attacker.invalid" }, 400],
      [{ Origin: app.baseURL.replace("http:", "https:") }, 400],
      [{ Origin: app.baseURL, "Sec-Fetch-Site": "cross-site" }, 403],
    ]) {
      // RR7 rejects mismatched/opaque origins with 400 before running the action.
      // Missing Origin and contradictory Fetch Metadata reach our stricter gate.
      const response = await request(dataPath("/", "routes/_index") + "&index", form, headers);
      assert.equal(response.status, expectedStatus, JSON.stringify(headers));
      assert.equal(response.headers.get("set-cookie"), null);
    }
  });

  await t.test("HTTPS proxy forwarding is accepted only from configured immediate peers", async (t) => {
    const origin = "https://w2w-test.invalid:8443";
    const forwarded = {
      Origin: origin,
      "X-Forwarded-Proto": "https",
      "X-Forwarded-Host": "w2w-test.invalid:8443",
      "X-Forwarded-Port": "8443",
      Forwarded: 'for=192.0.2.10;proto=https;host="w2w-test.invalid:8443"',
    };
    const loginPath = dataPath("/", "routes/_index") + "&index";
    const invalidLogin = { intent: "OAuthCallback", credential: "not-a-jwt" };

    const untrustedClient = await visitor(app.baseURL);
    let response = await untrustedClient(loginPath, invalidLogin, forwarded);
    assert.equal(response.status, 400, "untrusted forwarding headers must not make a foreign Origin valid");

    const proxied = await startApplication({ trustedProxyCIDRs: "127.0.0.1/32,::1/128" });
    t.after(proxied.stop);
    const client = await visitor(proxied.baseURL);
    const text = await createText(client);
    response = await client(text.data, {
      intent: "save", title: "HTTPS forwarding", content: "Saved behind the trusted proxy", language: "plaintext", updateCount: "1",
    }, forwarded);
    assert.equal(response.status, 200);
    assert.equal((await decodeData(response)).success, true);
    assert.equal((await readText(client, text.data)).content, "Saved behind the trusted proxy");

    response = await client(loginPath, invalidLogin, forwarded);
    assert.equal(response.status, 401, "matching HTTPS origin must reach credential validation");
    assert.equal(response.headers.get("set-cookie"), null);
    response = await client(loginPath, invalidLogin, { ...forwarded, Origin: "https://attacker.invalid" });
    assert.equal(response.status, 400, "a trusted proxy must not allow a foreign browser origin");
    assert.equal((await client(text.path, { intent: "delete" })).status, 400);

    const unrelatedProxy = await startApplication({ trustedProxyCIDRs: "192.0.2.1/32" });
    t.after(unrelatedProxy.stop);
    const directClient = await visitor(unrelatedProxy.baseURL);
    response = await directClient(loginPath, invalidLogin, {
      ...forwarded,
      Origin: unrelatedProxy.baseURL,
    });
    assert.equal(response.status, 401, "untrusted headers must not change the port or scheme of a direct same-origin request");
    response = await directClient(loginPath, invalidLogin, forwarded);
    assert.equal(response.status, 400, "enabling trust for another peer must not trust the local caller");
  });
});
