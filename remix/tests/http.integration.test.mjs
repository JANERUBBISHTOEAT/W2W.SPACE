import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

test("production HTTP workflows and session boundaries", { timeout: 60000 }, async (t) => {
  const app = await startApplication();
  t.after(app.stop);

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

  await t.test("home renders the Pages help link and canonical source repository", async () => {
    const response = await createClient(app.baseURL)("/");
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /href="https:\/\/janerubbishtoeat\.github\.io\/W2W\.SPACE\/#why-w2w">\| Why W2W\?<\/a>/);
    assert.match(html, /href="https:\/\/github\.com\/JANERUBBISHTOEAT\/W2W\.SPACE">\| View on GitHub<\/a>/);
    assert.ok(!html.includes("CSCC09-24F-Project"), "The footer must not use the old repository path");
  });

  await t.test("Remix 2 signed visitor cookies retain identity and reject tampering", async () => {
    const cookie = app.legacySessionCookie({ visitor: { sub: "legacy-remix2-visitor", name: "旧会话" } });
    const request = createClient(app.baseURL, cookie);
    const response = await request("/");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("set-cookie"), null, "an existing visitor must not be replaced");
    const text = await createText(request);
    const secondClient = createClient(app.baseURL, cookie);
    const saved = await readText(secondClient, text.data);
    assert.equal(saved.owner, true, "the old cookie must retain access to its own collection");
    assert.equal(saved.id, text.id);
    const tampered = createClient(app.baseURL, cookie + "tampered");
    assert.equal((await tampered("/api/new/text", {})).status, 401);
    const deleted = await secondClient(text.data, { intent: "delete" });
    assert.equal(deleted.status, 202);
    const redirect = await decodeStream(deleted);
    assert.equal(redirect.status, 302);
    const destination = new URL(redirect.redirect, app.baseURL);
    assert.equal(destination.pathname, "/");
    assert.equal(destination.searchParams.get("undoId"), text.id);
    assert.equal(destination.searchParams.get("undoType"), "text");
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
    assert.equal((await decodeData(response)).success, true);
    const saved = await readText(collaborator, text.data);
    assert.equal(saved.content, "共享文本 ✓");
    assert.equal(saved.title, "Unicode regression");
    assert.equal(saved.owner, false);
    response = await collaborator(`/token/${created.token}`);
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), text.path);
    response = await collaborator(dataPath(`/token/${created.token}`, "routes/token.$token"));
    assert.equal(response.status, 202);
    const sharedRedirect = (await decodeStream(response))[UNSAFE_SingleFetchRedirectSymbol];
    assert.equal(sharedRedirect.status, 302);
    assert.equal(sharedRedirect.redirect, text.path);

    response = await collaborator(text.data, {
      intent: "save", title: "Empty content", content: "", language: "plaintext", updateCount: "2",
    });
    assert.equal(response.status, 200);
    assert.equal((await decodeData(response)).success, true);
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

  await t.test("file metadata updates stay on the requested file when an empty draft exists", async () => {
    const owner = await visitor(app.baseURL);
    const magnet = "magnet:?xt=urn:btih:1111111111111111111111111111111111111111&dn=metadata.txt";
    let response = await owner("/api/new/token", { intent: "acquireToken", magnet });
    assert.equal(response.status, 200);
    const original = await response.json();
    const fileRoute = "routes/files.$fileId";
    const editRoute = "routes/files.$fileId_.edit";
    const originalPath = `/files/${original.fileId}`;
    response = await owner(dataPath(originalPath, fileRoute));
    const before = (await decodeData(response, fileRoute)).file;

    response = await owner("/new", { type: "file" });
    assert.equal(response.status, 302);
    const draftEditPath = response.headers.get("location");
    assert.match(draftEditPath, /^\/files\/[^/?]+\/edit$/);
    const draftPath = draftEditPath.replace(/\/edit$/, "");
    assert.notEqual(draftPath, originalPath);

    response = await owner(dataPath(`${originalPath}/edit`, editRoute));
    assert.equal(response.status, 200);
    const opened = (await decodeData(response, editRoute)).file;
    assert.equal(opened.id, original.fileId, "opening a populated file must not return the empty draft");
    assert.equal(opened.magnet, magnet);
    assert.equal(opened.filename, before.filename);
    assert.equal(opened.accessCount, before.accessCount + 1);

    response = await owner(dataPath(originalPath, fileRoute), { favorite: "true" });
    assert.equal(response.status, 200);
    const favorited = await decodeData(response);
    assert.equal(favorited.id, original.fileId);
    assert.equal(favorited.favorite, true);
    assert.equal(favorited.magnet, magnet);
    response = await owner(dataPath(originalPath, fileRoute));
    assert.equal((await decodeData(response, fileRoute)).file.favorite, true, "the favorite update must be persisted on the original");
    response = await owner(dataPath(draftPath, fileRoute));
    const draft = (await decodeData(response, fileRoute)).file;
    assert.equal(draft.magnet, undefined);
    assert.equal(draft.filename, undefined);
    assert.equal(draft.favorite, undefined);
    assert.equal((await owner(`${originalPath}/destroy`, {})).status, 302);
    assert.equal((await owner(`${draftPath}/destroy`, {})).status, 302);
  });

  await t.test("file saves deduplicate matching identity and notes while preserving distinct notes", async () => {
    const owner = await visitor(app.baseURL);
    const magnet = "magnet:?xt=urn:btih:2222222222222222222222222222222222222222&dn=duplicate.txt";
    let response = await owner("/api/new/token", { intent: "acquireToken", magnet });
    assert.equal(response.status, 200);
    const original = await response.json();
    const originalPath = `/files/${original.fileId}`;
    const save = { fileName: "New File", magnet, fileSize: "0", fileType: "text/plain", notes: "" };

    response = await owner("/new", { type: "file" });
    assert.equal(response.status, 302);
    const duplicateEditPath = response.headers.get("location");
    response = await owner(duplicateEditPath, save);
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), `${originalPath}/edit?message=Existing+file+found`);
    response = await owner(duplicateEditPath.replace(/\/edit$/, ""));
    assert.equal(response.status, 302, "saving the exact duplicate must remove the redundant draft");
    assert.equal(response.headers.get("location"), "/?message=Page+Not+Found");

    response = await owner("/new", { type: "file" });
    const separateEditPath = response.headers.get("location");
    const separatePath = separateEditPath.replace(/\/edit$/, "");
    const separateId = separatePath.split("/").pop();
    response = await owner(separateEditPath, { ...save, notes: "Keep this annotation" });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), `${separatePath}/?message=File+saved`);
    response = await owner("/api/files", { fileid: separateId, filename: "New File" });
    assert.equal(response.status, 200);
    const updated = (await response.json()).file;
    assert.equal(updated.id, separateId, "an omitted notes field must retain the current record's distinct notes");
    assert.equal(updated.notes, "Keep this annotation");
    assert.equal(updated.magnet, magnet);
    assert.equal((await owner(originalPath)).status, 200);
    assert.equal((await owner(`${originalPath}/destroy`, {})).status, 302);
    assert.equal((await owner(`${separatePath}/destroy`, {})).status, 302);
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
    assert.equal((await client(text.path, { intent: "delete" })).status, 302);

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
