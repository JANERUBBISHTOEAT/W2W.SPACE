import assert from "node:assert/strict";
import test from "node:test";
import { buildFuture, createClient, startApplication } from "./helpers.mjs";

const dataPath = (path, route) => `${path}?_data=${encodeURIComponent(route)}`;

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
  return { path, id: path.split("/").pop(), data: dataPath(path, "routes/texts.$textId") };
}

async function readText(request, path) {
  const response = await request(path);
  assert.equal(response.status, 200);
  return (await response.json()).text;
}

test("production HTTP workflows and session boundaries", { timeout: 60000 }, async (t) => {
  const app = await startApplication();
  t.after(app.stop);

  await t.test("health reports the intended revision; Single Fetch remains disabled", async () => {
    const response = await createClient(app.baseURL)("/health");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("set-cookie"), null);
    assert.deepEqual(await response.json(), { status: "ok", version: "test-revision" });
    assert.equal((await buildFuture(app.redis)).v3_singleFetch, false);
  });

  await t.test("creation requires a session; home creates a visitor session", async () => {
    for (const [path, form] of [
      ["/api/new/text", {}],
      ["/api/new/file", { fileName: "test.txt", mimeType: "text/plain" }],
      ["/new", { type: "text" }],
      ["/new", { type: "file" }],
      ["/api/new/token", { intent: "acquireToken", magnet: "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567" }],
    ]) {
      const request = createClient(app.baseURL);
      assert.equal((await request(path, form)).status, 401, path);
    }
    const request = await visitor(app.baseURL);
    const response = await request("/css/app.css");
    assert.equal(response.status, 200);
    assert((await response.text()).length > 100);
  });

  await t.test("text saves, shares, permits collaboration and preserves empty content", async () => {
    const owner = await visitor(app.baseURL);
    const collaborator = await visitor(app.baseURL);
    const text = await createText(owner);
    const created = await readText(owner, text.data);
    assert.equal(created.id, text.id);
    assert.equal(created.owner, true);
    assert(created.token);
    let response = await owner(text.data, {
      intent: "save", title: "Unicode regression", content: "共享文本 ✓", language: "plaintext", updateCount: "1",
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).success, true);
    const saved = await readText(collaborator, text.data);
    assert.equal(saved.content, "共享文本 ✓");
    assert.equal(saved.title, "Unicode regression");
    assert.equal(saved.owner, false);
    response = await collaborator(`/token/${created.token}`);
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), text.path);

    response = await collaborator(text.data, {
      intent: "save", title: "Empty content", content: "", language: "plaintext", updateCount: "2",
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).success, true);
    const empty = await readText(owner, text.data);
    assert.equal(empty.content, "");
    assert.equal(empty.updateCount, 2);
    assert.equal(empty.owner, true);
    assert.equal((await owner(text.path, { intent: "delete" })).status, 302);
  });

  await t.test("viewing cannot revoke ownership; deletion and undo are owner scoped", async () => {
    const owner = await visitor(app.baseURL);
    const other = await visitor(app.baseURL);
    const anonymous = createClient(app.baseURL);
    const text = await createText(owner);
    const token = (await readText(owner, text.data)).token;
    assert.equal((await readText(other, text.data)).owner, false);
    assert.equal((await readText(anonymous, text.data)).owner, false);
    assert.equal((await anonymous(text.path, { intent: "delete" })).status, 403);
    assert.equal((await other(text.path, { intent: "delete" })).status, 403);
    assert.equal((await readText(owner, text.data)).owner, true);
    assert.equal((await owner(text.path, { intent: "delete" })).status, 302);
    let response = await other(`/token/${token}`);
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/deleted");
    const undo = { undoId: text.id, undoType: "text" };
    assert.equal((await createClient(app.baseURL)("/api/restore", undo)).status, 401);
    assert.equal((await other("/api/restore", undo)).status, 404);
    response = await owner("/api/restore", undo);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true, type: "text", id: text.id, url: text.path });
    assert.equal((await readText(owner, text.data)).id, text.id);
    assert.equal((await owner("/api/restore", undo)).status, 404, "undo is consumed once");
    response = await owner(`/token/${token}`);
    assert.equal(response.headers.get("location"), text.path);
    assert.equal((await owner(text.path, { intent: "delete" })).status, 302);
  });

  await t.test("file token API returns the magnet and sharing redirect; undo is scoped", async () => {
    const owner = await visitor(app.baseURL);
    const other = await visitor(app.baseURL);
    const magnet = "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=integration.txt";
    let response = await owner("/api/new/token", { intent: "acquireToken", magnet });
    assert.equal(response.status, 200);
    const file = await response.json();
    assert(file.fileId && file.token);
    response = await other(`/api/${file.fileId}/token`, { intent: "acquireMagnet", token: file.token });
    assert.equal(response.status, 200);
    const resolved = await response.json();
    assert.equal(resolved.type, "file");
    assert.equal(resolved.magnet, magnet);
    response = await other(`/token/${file.token}`);
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), `/?token=${file.token}`);
    response = await owner(`/files/${file.fileId}`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /New File/);
    assert.equal((await other(`/files/${file.fileId}/destroy`, {})).status, 404);
    assert.equal((await owner(`/files/${file.fileId}/destroy`, {})).status, 302);
    const undo = { undoId: file.fileId, undoType: "file" };
    assert.equal((await other("/api/restore", undo)).status, 404);
    response = await owner("/api/restore", undo);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).id, file.fileId);
    response = await owner(`/api/${file.fileId}/token`, { intent: "acquireMagnet", token: file.token });
    assert.equal((await response.json()).magnet, magnet);
    assert.equal((await owner(`/files/${file.fileId}/destroy`, {})).status, 302);
  });

  await t.test("a shared file survives source deletion until its final recipient deletes it", async () => {
    const sender = await visitor(app.baseURL);
    const recipient = await visitor(app.baseURL);
    const magnet = "magnet:?xt=urn:btih:abcdef0123456789abcdef0123456789abcdef0123&dn=shared-recipient.txt";
    let response = await sender("/api/new/token", { intent: "acquireToken", magnet });
    assert.equal(response.status, 200);
    const source = await response.json();
    assert(source.fileId && source.token);
    response = await recipient("/api/new/token", { intent: "acquireMagnet", token: source.token });
    assert.equal(response.status, 200);
    const copy = await response.json();
    assert(copy.fileId);
    assert.notEqual(copy.fileId, source.fileId);
    assert.equal(copy.magnet, magnet);

    assert.equal((await sender(`/files/${source.fileId}/destroy`, {})).status, 302);
    response = await recipient(`/api/${copy.fileId}/token`, { intent: "acquireMagnet", token: source.token });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).magnet, magnet);
    response = await recipient(`/token/${source.token}`);
    assert.equal(response.headers.get("location"), `/?token=${source.token}`);

    assert.equal((await recipient(`/files/${copy.fileId}/destroy`, {})).status, 302);
    response = await sender(`/token/${source.token}`);
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "/deleted");
    response = await sender(`/api/${source.fileId}/token`, { intent: "acquireMagnet", token: source.token });
    assert.equal(response.status, 404);
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
    assert.equal((await state.json()).user, null);
  });

  await t.test("Google login rejects missing, opaque and cross-origin requests", async () => {
    const request = await visitor(app.baseURL);
    const form = { intent: "OAuthCallback", credential: "not-a-jwt" };
    for (const headers of [
      {},
      { Origin: "null" },
      { Origin: "https://attacker.invalid" },
      { Origin: app.baseURL, "Sec-Fetch-Site": "cross-site" },
    ]) {
      // Remix 2 rejects mismatched Origin on document submissions before the
      // route runs. Exercise the fetcher action path used by GoogleLogin so the
      // application's own Origin checks must reject every case with 403.
      const response = await request(dataPath("/", "routes/_index"), form, headers);
      assert.equal(response.status, 403, JSON.stringify(headers));
      assert.equal(response.headers.get("set-cookie"), null);
    }
  });
});
