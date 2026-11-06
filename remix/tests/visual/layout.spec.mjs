import { test, expect } from "@playwright/test";
import Redis from "ioredis";
import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startApplication } from "../helpers.mjs";

const currentRoot = fileURLToPath(new URL("../../..", import.meta.url));
const baselineRoot = process.env.W2W_VISUAL_BASELINE_ROOT;
const mode = process.env.W2W_VISUAL_MODE || "model";
const fileId = "visual-file";
const draftId = "visual-draft";
const filename = "visual-fixture.txt";
const notes = "A note kept in this browser.";
const content = "Visual text fixture\nAnonymous text stays editable.\n";
const magnet = "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=visual-fixture.txt";
const viewer = "visual-viewer";
const createdAt = new Date().toISOString();
const googleScript = `window.google = { accounts: { id: {
  initialize() {}, cancel() {}, disableAutoSelect() {},
  renderButton(container) {
    const button = document.createElement('button');
    button.type = 'button'; button.textContent = 'Sign in with Google';
    container.replaceChildren(button);
  }
} } };`;
let baseline;
let current;

async function hasLocalFiles(root) {
  try { await access(join(root, "remix/app/utils/files.local.ts")); return true; } catch { return false; }
}

async function post(application, path, form, identity = viewer) {
  return fetch(application.baseURL + path, {
    method: "POST", redirect: "manual",
    headers: { Cookie: application.legacySessionCookie({ visitor: { sub: identity } }) },
    body: new URLSearchParams(form), signal: AbortSignal.timeout(10000),
  });
}

async function fixtures(application, root, token) {
  const local = await hasLocalFiles(root);
  let share;
  if (local) {
    const response = await post(application, "/api/new/token", {
      intent: "acquireToken", magnet, filename, filetype: "text/plain", filesize: "48",
    });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.share?.id).toBe("0123456789abcdef0123456789abcdef01234567");
    share = result.share;
  } else {
    share = { id: fileId, filename, magnet, type: "text/plain", size: 48, token, lastAccessedAt: createdAt };
    const redis = new Redis({ host: application.redis.host, port: application.redis.port });
    try {
      await redis.hset(`user:${viewer}:files`, fileId, JSON.stringify({
        ...share, notes, favorite: true, owner: true, createdAt, lastEditedAt: createdAt,
      }));
      await redis.hset(`user:${viewer}-draft:files`, draftId, JSON.stringify({
        id: draftId, token: "654321", filename: "", owner: true,
        createdAt, lastEditedAt: createdAt, lastAccessedAt: createdAt,
      }));
      await redis.hset("unifiedTokenMap", token, JSON.stringify({ type: "file", id: fileId, status: "OK" }));
      await redis.hset("unifiedTokenMap", "654321", JSON.stringify({ type: "file", id: draftId, status: "OK" }));
    } finally { await redis.quit(); }
  }
  const creation = await post(application, "/new", { type: "text" }, "visual-text-creator");
  expect([302, 303]).toContain(creation.status);
  const textPath = creation.headers.get("location");
  expect(textPath).toMatch(/^\/texts\//);
  const saved = await post(application, textPath, {
    intent: "save", content, title: "Visual text fixture", language: "markdown", updateCount: "1",
  }, "visual-text-creator");
  expect(saved.status).toBe(200);
  return { application, root, local, share, textPath };
}

test.beforeAll(async () => {
  if (!baselineRoot) throw new Error("W2W_VISUAL_BASELINE_ROOT must point to a separately built baseline checkout");
  expect(["model", "ui"]).toContain(mode);
  const oldHelpers = await import(pathToFileURL(join(resolve(baselineRoot), "remix/tests/helpers.mjs")).href);
  const started = await Promise.allSettled([oldHelpers.startApplication(), startApplication()]);
  if (started.some(result => result.status === "rejected")) {
    await Promise.all(started.filter(result => result.status === "fulfilled").map(result => result.value.stop()));
    throw started.find(result => result.status === "rejected").reason;
  }
  const applications = started.map(result => result.value);
  // Store process handles immediately so fixture failures are cleaned up too.
  baseline = { application: applications[0] };
  current = { application: applications[1] };
  current = await fixtures(current.application, currentRoot);
  baseline = await fixtures(baseline.application, resolve(baselineRoot), current.share.token);
});

test.afterAll(async () => {
  await Promise.all([baseline?.application.stop(), current?.application.stop()]);
});

async function openScenario(browser, state, scenario, viewport) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, locale: "en-US", timezoneId: "UTC", reducedMotion: "reduce" });
  const cookie = state.application.legacySessionCookie({ visitor: { sub: scenario === "draft" ? `${viewer}-draft` : viewer } });
  // Empty pages and text readers deliberately have no personal records in either model.
  const hasFile = ["file", "edit", "draft"].includes(scenario);
  const activeCookie = hasFile ? cookie : state.application.legacySessionCookie({ visitor: { sub: "visual-empty" } });
  await context.addCookies([{ name: "session", value: activeCookie.slice("session=".length), url: state.application.baseURL, httpOnly: true, sameSite: "Lax" }]);
  if (state.local && hasFile) {
    const localFiles = scenario === "draft"
      ? [{ id: draftId, displayName: "", notes: "", favorite: false, createdAt, direction: "seed" }]
      : [{ id: fileId, shareId: state.share.id, displayName: filename, notes, favorite: true, createdAt, direction: "seed", share: state.share }];
    await context.addInitScript(files => localStorage.setItem("w2w.files.v1", JSON.stringify(files)), localFiles);
  }
  const origin = new URL(state.application.baseURL).origin;
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin === origin) return route.continue();
    if (url.hostname === "accounts.google.com" && url.pathname === "/gsi/client") {
      return route.fulfill({ contentType: "application/javascript", body: googleScript });
    }
    if (url.pathname.includes("/min/vs/")) {
      const relative = url.pathname.slice(url.pathname.indexOf("/min/vs/") + 8);
      if (!relative.split("/").includes("..")) {
        const path = join(currentRoot, "remix/node_modules/monaco-editor/min/vs", relative);
        try {
          await access(path);
          return route.fulfill({ path, headers: { "Access-Control-Allow-Origin": "*" } });
        } catch { /* Unknown external asset stays blocked. */ }
      }
    }
    return route.abort();
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  const activeId = state.local ? state.share.id : fileId;
  const paths = { home: "/", new: "/new", draft: `/files/${draftId}/edit`, file: `/files/${activeId}`, edit: `/files/${activeId}/edit`, text: state.textPath };
  const response = await page.goto(state.application.baseURL + paths[scenario], { waitUntil: "networkidle" });
  expect(response.status()).toBe(200);
  expect(new URL(page.url()).pathname).toBe(paths[scenario]);
  await expect(page.locator("#sidebar")).toBeVisible();
  if (scenario === "new") await expect(page.getByRole("button", { name: /New File/ })).toBeVisible();
  if (scenario === "file") await expect(page.locator("#contact")).toContainText(filename);
  if (scenario === "edit") await expect(page.getByRole("textbox", { name: "Filename", exact: true })).toHaveValue(filename);
  if (scenario === "draft") await expect(page.locator("#dropzone")).toBeVisible();
  if (scenario === "text") await expect(page.locator(".monaco-editor")).toBeVisible({ timeout: 20000 });
  await page.evaluate(() => document.fonts.ready);
  await page.addStyleTag({ content: "*,*::before,*::after { animation: none !important; transition: none !important; caret-color: transparent !important; }" });
  expect(pageErrors).toEqual([]);
  return { context, page };
}

async function normalizeRandomToken(page, token) {
  // Normalize only the known random fixture code, retaining all layout, text
  // nodes, typography and controls. Full artifacts above remain unmodified.
  await page.evaluate(value => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.parentElement?.closest("script,style")) continue;
      node.textContent = node.textContent.replaceAll(value, "123456");
    }
    for (const input of document.querySelectorAll('input[name="token"]')) {
      if (input.value === value) input.value = "123456";
    }
  }, token);
}

const scenarios = ["home", "new", "draft", "file", "edit", "text"];
for (const viewport of [{ name: "desktop", width: 1440, height: 1000 }, { name: "mobile", width: 390, height: 844 }]) {
  for (const scenario of scenarios) {
    test(`${viewport.name} ${scenario} preserves unaffected layout`, async ({ browser }, testInfo) => {
      const before = await openScenario(browser, baseline, scenario, viewport);
      const after = await openScenario(browser, current, scenario, viewport);
      try {
        // Unmasked artifacts always show the actual product, including every
        // intentional semantic/UI difference. Assertions below are narrower.
        for (const [label, view] of [["before", before], ["after", after]]) {
          const path = testInfo.outputPath(`${label}.png`);
          await view.page.screenshot({ path, fullPage: true, animations: "disabled" });
          await testInfo.attach(label, { path, contentType: "image/png" });
        }
        const regions = scenario === "home" && mode === "ui" ? ["#sidebar", ".footer"] : [null];
        const masks = [];
        if (scenario === "home" && mode === "model") {
          // Anonymous File records no longer sync through Google. Normalize
          // this required copy change only; the entire login UI stays tested.
          const oldCaption = before.page.locator(".login-button > p");
          const newCaption = after.page.locator(".login-button > p");
          await expect(oldCaption).toHaveText("log in to sync file history:");
          await expect(newCaption).toHaveText("log in with your Google account:");
          for (const caption of [oldCaption, newCaption]) await caption.evaluate(element => { element.textContent = "log in with your Google account:"; });
        }
        if (scenario === "draft" && mode === "model") {
          await expect(before.page.locator('input[name="token"]')).toHaveValue("654321");
          await expect(after.page.locator('input[name="token"]')).toHaveValue("");
          await expect(before.page.locator("#sidebar nav a")).toHaveText("#654321");
          await expect(after.page.locator("#sidebar nav a")).toHaveText("No Name");
          // Token issuance moves from draft creation to publication. Normalize
          // only that value/label, preserving the whole sidebar and field pixels.
          await before.page.locator('input[name="token"]').evaluate(input => { input.value = ""; });
          await before.page.locator("#sidebar nav a").evaluate(anchor => {
            const label = document.createElement("i");
            label.textContent = "No Name";
            const icon = anchor.querySelector(".fa-upload");
            anchor.replaceChildren(label, document.createTextNode(" "), icon);
          });
        }
        if (["file", "edit"].includes(scenario)) {
          await normalizeRandomToken(before.page, baseline.share.token);
          await normalizeRandomToken(after.page, current.share.token);
        }
        if (scenario === "text") masks.push('input[name="token"]');
        if (scenario === "text" && mode === "model") {
          masks.push('#text-editor-header-right button:last-child');
          for (const selector of ["#text-editor-header", "#text-editor-header-right button:last-child", "#text-editor-wrapper", "#text-editor-footer"]) {
            expect(await after.page.locator(selector).boundingBox()).toEqual(await before.page.locator(selector).boundingBox());
          }
        }
        for (let i = 0; i < regions.length; i++) {
          const selector = regions[i];
          const oldTarget = selector ? before.page.locator(selector) : before.page;
          const newTarget = selector ? after.page.locator(selector) : after.page;
          if (selector) expect(await newTarget.boundingBox()).toEqual(await oldTarget.boundingBox());
          const screenshotOptions = page => ({ animations: "disabled", ...(selector ? {} : { fullPage: true }), mask: masks.map(mask => page.locator(mask)) });
          const expected = await oldTarget.screenshot(screenshotOptions(before.page));
          const name = `${viewport.name}-${scenario}-${i}.png`;
          const expectedPath = testInfo.snapshotPath(name);
          await mkdir(dirname(expectedPath), { recursive: true });
          await writeFile(expectedPath, expected);
          const actual = await newTarget.screenshot(screenshotOptions(after.page));
          expect(actual).toMatchSnapshot(name, { maxDiffPixels: 0, threshold: 0 });
        }
        testInfo.annotations.push({
          type: "visual exclusions",
          description: JSON.stringify({ mode, masks, regions, reason: "Only explicit anonymity semantics, random tokens, and requested token-input UI changes are excluded. Full unmasked images are attached." }),
        });
      } finally { await before.context.close(); await after.context.close(); }
    });
  }
}
