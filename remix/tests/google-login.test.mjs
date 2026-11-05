import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import Redis from "ioredis";
import { UNSAFE_decodeViaTurboStream } from "react-router";
import { createClient, startApplication } from "./helpers.mjs";

const require = createRequire(import.meta.url);
const audience = "w2w-integration-test.apps.googleusercontent.com";
const challengePath = "/api/auth/google/challenge";
const indexDataPath = "/_root.data?_routes=routes%2F_index";
const loginPath = `${indexDataPath}&index`;
const nonceKey = (nonce) => `google-login:nonce:${nonce}`;
const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

async function routeData(response, route) {
  const { value } = await UNSAFE_decodeViaTurboStream(response.body, globalThis);
  const result = route ? value[route] : value;
  if (result.error) throw result.error;
  return result.data;
}

async function dataSnapshot(redis) {
  const keys = (await redis.keys("*")).filter((key) => !key.startsWith("google-login:nonce:")).sort();
  return Promise.all(keys.map(async (key) => [key, (await redis.dumpBuffer(key)).toString("hex")]));
}

async function issue(request, baseURL) {
  const response = await request(challengePath, {}, { Origin: baseURL });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("set-cookie"), null, "challenge issuance must not overwrite the root session cookie");
  assert.match(response.headers.get("cache-control") || "", /no-store/);
  const challenge = await response.json();
  assert.match(challenge.nonce, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(challenge.expiresIn, 600, "browser refresh uses a relative lifetime, independent of its wall clock");
  assert(challenge.expiresAt > Date.now());
  assert(challenge.expiresAt <= Date.now() + 601000);
  return challenge;
}

test("Google login uses signed, session-bound one-time challenges", { timeout: 90000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "w2w-google-certs-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const certificatePath = join(directory, "certificates.mjs");
  // Only this ephemeral test child trusts our local public key. Token parsing,
  // RSA signature, audience, issuer and expiry checks use the real library.
  // The private signing key remains in this test process and is never saved.
  await writeFile(certificatePath, `
    import { OAuth2Client } from ${JSON.stringify(pathToFileURL(require.resolve("google-auth-library")).href)};
    OAuth2Client.prototype.getFederatedSignonCertsAsync = async () => ({
      certs: { "w2w-local-test-key": ${JSON.stringify(publicKey.export({ type: "spki", format: "pem" }))} },
      format: "PEM",
    });
  `);
  const app = await startApplication({ nodeImports: [pathToFileURL(certificatePath).href] });
  t.after(app.stop);
  const redis = new Redis({ host: app.redis.host, port: app.redis.port });
  t.after(() => redis.quit());

  function credential(nonce, overrides = {}, header = { alg: "RS256", kid: "w2w-local-test-key" }) {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iss: "https://accounts.google.com", aud: audience,
      sub: "local-google-user", name: "Local verification", email: "local@example.invalid",
      iat: now, exp: now + 3600, nonce, ...overrides,
    };
    const input = `${encode(header)}.${encode(payload)}`;
    return `${input}.${sign("RSA-SHA256", Buffer.from(input), privateKey).toString("base64url")}`;
  }

  function visitor(name) {
    const cookie = app.legacySessionCookie({ visitor: { sub: name } });
    return { cookie, request: createClient(app.baseURL, cookie) };
  }

  async function login(request, nonce, token = credential(nonce), headers = { Origin: app.baseURL }) {
    return request(loginPath, { intent: "OAuthCallback", nonce, credential: token }, headers);
  }

  async function rejectedLogin(request, nonce, token, expected = 401, headers) {
    const before = await dataSnapshot(redis);
    const response = await login(request, nonce, token, headers);
    assert.equal(response.status, expected);
    assert.equal(response.headers.get("set-cookie"), null);
    await response.text();
    assert.deepEqual(await dataSnapshot(redis), before, "a rejected login must not migrate or alter saved records");
    return response;
  }

  await t.test("challenge issuance requires an existing signed session and same-origin POST", async () => {
    const anonymous = createClient(app.baseURL);
    let response = await anonymous(challengePath, {}, { Origin: app.baseURL });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("set-cookie"), null);
    const owner = visitor("challenge-guards");
    response = await owner.request(challengePath, {});
    assert.equal(response.status, 403);
    response = await owner.request(challengePath, {}, { Origin: "https://attacker.invalid" });
    assert([400, 403].includes(response.status));
    response = await owner.request(challengePath, {}, { Origin: app.baseURL, "Sec-Fetch-Site": "cross-site" });
    assert.equal(response.status, 403);
    assert.equal((await redis.keys("google-login:nonce:*")).length, 0);
    const challenge = await issue(owner.request, app.baseURL);
    const ttl = await redis.ttl(nonceKey(challenge.nonce));
    assert(ttl > 0 && ttl <= 600);
  });

  await t.test("invalid claims and signatures neither sign in nor consume a valid challenge", async () => {
    const owner = visitor("invalid-claims-visitor");
    assert.equal((await owner.request("/api/new/text", {})).status, 302);
    const { nonce } = await issue(owner.request, app.baseURL);
    const now = Math.floor(Date.now() / 1000);
    const signed = credential(nonce);
    const inputs = [
      ["malformed token", "not-a-jwt"],
      ["unsigned token", `${encode({ alg: "none" })}.${encode({ sub: "forged" })}.unsigned`],
      ["wrong nonce", credential("a".repeat(43))],
      ["missing signed nonce", credential(nonce, { nonce: undefined })],
      ["wrong audience", credential(nonce, { aud: "another-client.apps.googleusercontent.com" })],
      ["wrong issuer", credential(nonce, { iss: "https://attacker.invalid" })],
      ["expired credential", credential(nonce, { iat: now - 7200, exp: now - 3600 })],
      ["future credential", credential(nonce, { iat: now + 3600, exp: now + 7200 })],
      ["missing subject", credential(nonce, { sub: undefined })],
      ["invalid signature", `${signed.slice(0, -12)}AAAAAAAAAAAA`],
    ];
    for (const [label, token] of inputs) {
      await rejectedLogin(owner.request, nonce, token);
      assert.equal(await redis.exists(nonceKey(nonce)), 1, `${label} must be rejected before challenge consumption`);
    }
    await rejectedLogin(owner.request, "", credential(nonce));
    await rejectedLogin(owner.request, "short", credential(nonce));
    await rejectedLogin(owner.request, nonce, signed, 403, {});
    await rejectedLogin(owner.request, nonce, signed, 403, { Origin: app.baseURL, "Sec-Fetch-Site": "cross-site" });
    const state = await owner.request(indexDataPath);
    assert.equal((await routeData(state, "routes/_index")).user, null);
    assert.equal(await redis.exists(nonceKey(nonce)), 1);
  });

  await t.test("another signed visitor cannot consume a challenge or migrate records", async () => {
    const owner = visitor("bound-owner");
    const other = visitor("bound-other");
    const { nonce } = await issue(owner.request, app.baseURL);
    await rejectedLogin(other.request, nonce, credential(nonce));
    await rejectedLogin(createClient(app.baseURL), nonce, credential(nonce));
    const sameSubjectDifferentRole = createClient(app.baseURL, app.legacySessionCookie({ user: { sub: "bound-owner" } }));
    await rejectedLogin(sameSubjectDifferentRole, nonce, credential(nonce));
    await rejectedLogin(createClient(app.baseURL, owner.cookie + "tampered"), nonce, credential(nonce));
    assert.equal(await redis.exists(nonceKey(nonce)), 1, "wrong browser must not burn the owner's pending challenge");
    const response = await login(owner.request, nonce, credential(nonce, { sub: "bound-google-user" }));
    assert.equal(response.status, 200);
    assert.equal((await routeData(response)).user.sub, "bound-google-user");
    assert.equal(await redis.exists(nonceKey(nonce)), 0);
  });

  await t.test("expired challenges fail without a login cookie or data migration", async () => {
    const owner = visitor("expired-challenge");
    const { nonce } = await issue(owner.request, app.baseURL);
    assert.equal(await redis.pexpire(nonceKey(nonce), 0), 1);
    await rejectedLogin(owner.request, nonce, credential(nonce));
  });

  await t.test("replaying the original signed visitor cookie cannot restore a consumed nonce", async () => {
    const owner = visitor("replay-visitor");
    const { nonce } = await issue(owner.request, app.baseURL);
    const token = credential(nonce, { sub: "replay-google-user" });
    const response = await login(owner.request, nonce, token);
    assert.equal(response.status, 200);
    await response.text();
    const staleCookie = createClient(app.baseURL, owner.cookie);
    await rejectedLogin(staleCookie, nonce, token);
    assert.equal(await redis.exists(nonceKey(nonce)), 0);
  });

  await t.test("concurrent callbacks for one challenge have exactly one winner", async () => {
    const owner = visitor("concurrent-visitor");
    const { nonce } = await issue(owner.request, app.baseURL);
    const token = credential(nonce, { sub: "concurrent-google-user" });
    const clients = [createClient(app.baseURL, owner.cookie), createClient(app.baseURL, owner.cookie)];
    const responses = await Promise.all(clients.map((request) => login(request, nonce, token)));
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 401]);
    assert.equal(responses.filter((response) => response.headers.has("set-cookie")).length, 1);
    await Promise.all(responses.map((response) => response.text()));
    assert.equal(await redis.exists(nonceKey(nonce)), 0);
  });

  await t.test("tabs have independent challenges and current-cookie identity changes invalidate old ones", async () => {
    const owner = visitor("multiple-tabs");
    const first = await issue(owner.request, app.baseURL);
    const second = await issue(owner.request, app.baseURL);
    assert.notEqual(first.nonce, second.nonce);
    assert.equal(await redis.exists(nonceKey(first.nonce), nonceKey(second.nonce)), 2);
    const response = await login(owner.request, first.nonce, credential(first.nonce, { sub: "tabs-google-user" }));
    assert.equal(response.status, 200);
    await response.text();
    assert.equal(await redis.exists(nonceKey(second.nonce)), 1, "new challenges must not replace an earlier tab's challenge");
    await rejectedLogin(owner.request, second.nonce, credential(second.nonce, { sub: "tabs-google-user" }));
    assert.equal(await redis.exists(nonceKey(second.nonce)), 1, "the updated user cookie must not consume a visitor-bound challenge");
    const fresh = await issue(owner.request, app.baseURL);
    const relogin = await login(owner.request, fresh.nonce, credential(fresh.nonce, { sub: "tabs-google-user" }));
    assert.equal(relogin.status, 200);
    await relogin.text();
  });

  await t.test("verified login migrates visitor history without breaking a recipient's shared link", async () => {
    const sender = visitor("migration-sender");
    const recipient = visitor("migration-recipient");
    const magnet = "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=nonce-login.txt";
    let response = await sender.request("/api/new/token", { intent: "acquireToken", magnet });
    assert.equal(response.status, 200);
    const source = await response.json();
    response = await recipient.request("/api/new/token", { intent: "acquireMagnet", token: source.token });
    assert.equal(response.status, 200);
    const copy = await response.json();
    response = await recipient.request("/api/new/text", {});
    assert.equal(response.status, 302);
    const textId = response.headers.get("location").split("/").pop();
    const { nonce } = await issue(recipient.request, app.baseURL);
    response = await login(recipient.request, nonce, credential(nonce, { sub: "migration-google-user" }));
    assert.equal(response.status, 200);
    assert.match(response.headers.get("set-cookie") || "", /Secure/i);
    assert.equal((await routeData(response)).user.sub, "migration-google-user");
    assert.equal(await redis.hlen("user:migration-recipient:files"), 0);
    assert.equal(await redis.hlen("user:migration-recipient:texts"), 0);
    assert(await redis.hget("user:migration-google-user:files", copy.fileId));
    assert(await redis.hget("user:migration-google-user:texts", textId));
    assert.equal((await sender.request(`/files/${source.fileId}/destroy`, {})).status, 302);
    response = await recipient.request(`/token/${source.token}`);
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), `/?token=${source.token}`);
    response = await recipient.request(indexDataPath);
    assert.equal((await routeData(response, "routes/_index")).user.sub, "migration-google-user");
  });

  await t.test("Redis command failures fail closed during issuance and consumption", async () => {
    const owner = visitor("redis-failure-visitor");
    const { nonce } = await issue(owner.request, app.baseURL);
    await redis.acl("SETUSER", "default", "-eval");
    try {
      await rejectedLogin(owner.request, nonce, credential(nonce), 503);
      assert.equal(await redis.exists(nonceKey(nonce)), 1);
    } finally {
      await redis.acl("SETUSER", "default", "+eval");
    }
    await redis.acl("SETUSER", "default", "-set");
    try {
      const before = await dataSnapshot(redis);
      const response = await owner.request(challengePath, {}, { Origin: app.baseURL });
      assert.equal(response.status, 503);
      assert.equal(response.headers.get("set-cookie"), null);
      assert.deepEqual(await dataSnapshot(redis), before);
    } finally {
      await redis.acl("SETUSER", "default", "+set");
    }
  });

  await t.test("a Redis timeout with uncertain consumption cannot sign in or migrate history", async () => {
    const owner = visitor("redis-timeout-visitor");
    assert.equal((await owner.request("/api/new/text", {})).status, 302);
    const { nonce } = await issue(owner.request, app.baseURL);
    const before = await dataSnapshot(redis);
    // The challenge client has a 2s command timeout. The paused server may later
    // execute its queued Lua script, so the application must treat the result as
    // uncertain and refuse login rather than restoring/reusing the challenge.
    // Only this suite's disposable Redis is paused; no production host is used.
    await redis.call("CLIENT", "PAUSE", "3500", "ALL");
    const response = await login(owner.request, nonce, credential(nonce, { sub: "timeout-google-user" }));
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("set-cookie"), null);
    await response.text();
    await redis.ping();
    assert.deepEqual(await dataSnapshot(redis), before);
    const state = await owner.request(indexDataPath);
    assert.equal((await routeData(state, "routes/_index")).user, null);
    const fresh = await issue(owner.request, app.baseURL);
    assert.notEqual(fresh.nonce, nonce, "an uncertain attempt must be recoverable with a fresh challenge");
  });
});
