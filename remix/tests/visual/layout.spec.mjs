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
const filename = mode === "responsive" ? "project-proposal-meeting-final-with-a-long-document-name.md" : "visual-fixture.txt";
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
  expect(["model", "ui", "responsive"]).toContain(mode);
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
  if (mode === "responsive" && state === current && viewport.width < 768) {
    await expect(page.locator("#mobile-header")).toBeVisible();
    await expect(page.locator("#sidebar")).not.toBeVisible();
  } else await expect(page.locator("#sidebar")).toBeVisible();
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
    for (const label of document.querySelectorAll('#sidebar nav a, #contact h1 [role="button"]')) {
      const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        // Short tokens can also occur in sizes and other ordinary page text.
        // Normalize only the fixture's token inside its displayed file label.
        node.textContent = node.textContent === value ? "123456" : node.textContent.replaceAll(`#${value}`, "#123456");
      }
    }
    for (const input of document.querySelectorAll('input[name="token"]')) {
      if (input.value === value) input.value = "123456";
    }
  }, token);
}

async function settleEditor(page) {
  // The editor element appears before its canvas overview ruler has painted.
  // Flush the public layout/render API, rather than ignoring canvas pixels.
  await page.waitForFunction(() => globalThis.monaco?.editor?.getEditors().length === 1);
  return page.evaluate(async () => {
    const monaco = globalThis.monaco;
    const editor = monaco.editor.getEditors()[0];
    editor.layout();
    editor.render(true);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return {
      language: editor.getModel().getLanguageId(),
      overviewRulerBorder: editor.getOption(monaco.editor.EditorOption.overviewRulerBorder),
      overviewRulerLanes: editor.getOption(monaco.editor.EditorOption.overviewRulerLanes),
    };
  });
}

async function controlTheme(locator) {
  return locator.evaluate(element => {
    const style = getComputedStyle(element);
    return {
      fontFamily: style.fontFamily,
      fontWeight: style.fontWeight,
      color: style.color,
      backgroundColor: style.backgroundColor,
      borderRadius: style.borderRadius,
    };
  });
}

async function assertResponsiveLayout(before, after, scenario, viewport, testInfo) {
  const page = after.page;
  const sidebar = await page.locator("#sidebar").boundingBox();
  const detail = await page.locator("#detail").boundingBox();
  expect(detail).not.toBeNull();
  const boxes = {};
  let mobileHeader = null;
  if (viewport.name === "desktop") {
    expect(sidebar).not.toBeNull();
    expect(sidebar.x).toBe(0);
    expect(sidebar.width).toBe(288);
    expect(detail.x).toBeCloseTo(sidebar.x + sidebar.width, 1);
  } else {
    await expect(page.locator("#sidebar")).not.toBeVisible();
    expect(sidebar).toBeNull();
    mobileHeader = await page.locator("#mobile-header").boundingBox();
    expect(mobileHeader).not.toBeNull();
    expect(mobileHeader.x).toBe(0);
    expect(mobileHeader.y).toBe(0);
    expect(mobileHeader.width).toBe(viewport.width);
    expect(mobileHeader.height).toBe(56);
    expect(detail.x).toBe(0);
    expect(detail.width).toBe(viewport.width);
    expect(detail.y).toBeCloseTo(mobileHeader.y + mobileHeader.height, 1);
    const search = page.locator("#mobile-search");
    const create = page.locator("#mobile-new");
    for (const button of [search, create]) {
      await expect(button).toBeVisible();
      await expect(button).toBeEnabled();
      await expect(button).toBeInViewport({ ratio: 1 });
    }
    const searchBox = await search.boundingBox();
    const newBox = await create.boundingBox();
    expect({ width: searchBox.width, height: searchBox.height }).toEqual({ width: 44, height: 44 });
    expect({ width: newBox.width, height: newBox.height }).toEqual({ width: searchBox.width, height: searchBox.height });
    expect(newBox.y).toBe(searchBox.y);
    expect(searchBox.x + searchBox.width <= newBox.x || newBox.x + newBox.width <= searchBox.x).toBe(true);
    expect(searchBox.x).toBeGreaterThanOrEqual(0);
    expect(newBox.x + newBox.width).toBeLessThanOrEqual(viewport.width);
    expect(searchBox.y + searchBox.height).toBeLessThanOrEqual(mobileHeader.y + mobileHeader.height);
    boxes.mobileSearch = searchBox;
    boxes.mobileNew = newBox;
  }
  expect(detail.width).toBeGreaterThan(240);
  expect(detail.x + detail.width).toBeLessThanOrEqual(viewport.width + 1);
  const overflow = await page.evaluate(() => {
    const detail = document.querySelector("#detail");
    return {
      document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      body: document.body.scrollWidth - document.documentElement.clientWidth,
      detail: detail.scrollWidth - detail.clientWidth,
    };
  });
  expect(overflow.document).toBeLessThanOrEqual(1);
  expect(overflow.body).toBeLessThanOrEqual(1);
  expect(overflow.detail).toBeLessThanOrEqual(1);

  async function usable(locator, name) {
    await expect(locator).toBeVisible();
    await locator.scrollIntoViewIfNeeded();
    await expect(locator).toBeInViewport({ ratio: 0.99 });
    const box = await locator.boundingBox();
    expect(box, name).not.toBeNull();
    expect(box.width, name).toBeGreaterThan(0);
    expect(box.x, name).toBeGreaterThanOrEqual(detail.x - 1);
    expect(box.x + box.width, name).toBeLessThanOrEqual(viewport.width + 1);
    boxes[name] = box;
  }

  const themeSelectors = {
    home: "#tokenInput",
    new: 'form:has(input[value="file"]) button',
    draft: '#contact-form button[type="submit"]',
    file: '#contact form[action$="edit"] button',
    edit: '#contact-form button[type="submit"]',
    text: "#text-editor-header-right button:first-of-type",
  };
  const themeSelector = themeSelectors[scenario];
  const oldTheme = await controlTheme(before.page.locator(themeSelector));
  const newTheme = await controlTheme(page.locator(themeSelector));
  if (viewport.name === "mobile" && ["draft", "file", "edit", "text"].includes(scenario)) {
    // The phone redesign makes Seed/Save primary actions while retaining the
    // application font and rounded controls. Desktop styling stays unchanged.
    expect(newTheme).toMatchObject({
      fontFamily: oldTheme.fontFamily,
      color: "rgb(255, 255, 255)",
      backgroundColor: "rgb(57, 146, 255)",
      borderRadius: "8px",
    });
  } else expect(newTheme).toEqual(oldTheme);

  if (scenario === "home") {
    const input = page.locator("#tokenInput");
    const initialBox = await input.boundingBox();
    if (viewport.name === "desktop") {
      expect(initialBox.y).toBe(215);
      const oldBox = await before.page.locator("#tokenInput").boundingBox();
      expect({ width: initialBox.width, height: initialBox.height }).toEqual({ width: oldBox.width, height: oldBox.height });
    }
    await usable(input, "token input");
    await expect(page.getByText("Receive using your token:", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Paste a token, or type all 6 digits to start.", { exact: true })).toHaveCount(0);
    for (const [index, link] of (await page.locator(".footer a:visible").all()).entries()) await usable(link, `footer link ${index}`);
  }
  if (scenario === "new") {
    for (const name of ["New File", "New Text"]) {
      const button = page.getByRole("button", { name: new RegExp(name) });
      await usable(button, name);
      await expect(button).toBeEnabled();
    }
  }
  if (["draft", "edit"].includes(scenario)) {
    await usable(page.locator("#dropzone"), "dropzone");
    const fields = page.locator('#contact-form input:not([type="hidden"]):not([type="file"]), #contact-form textarea, #contact-form button');
    for (const [index, field] of (await fields.all()).entries()) await usable(field, `file control ${index}`);
    for (const selector of ["#copy-token", "#copy-magnet"]) {
      if (scenario === "draft") await expect(page.locator(selector)).toBeDisabled();
      else await expect(page.locator(selector)).toBeEnabled();
    }
  }
  if (scenario === "file") {
    await usable(page.locator('#contact h1 [role="button"]'), "long filename");
    for (const [index, button] of (await page.locator("#contact button").all()).entries()) await usable(button, `file action ${index}`);
    const headingOverflow = await page.locator("#contact h1").evaluate(element => element.scrollWidth - element.clientWidth);
    expect(headingOverflow).toBeLessThanOrEqual(1);
  }
  if (scenario === "text") {
    const controls = page.locator("#text-editor-header input, #text-editor-header button, #text-editor-header select");
    for (const [index, control] of (await controls.all()).entries()) await usable(control, `text control ${index}`);
    const editor = await page.locator("#text-editor-wrapper").boundingBox();
    expect(editor.width).toBeGreaterThanOrEqual(240);
    expect(editor.height).toBeGreaterThanOrEqual(160);
    expect(editor.x + editor.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(await page.evaluate(() => globalThis.monaco.editor.getEditors()[0].getValue())).toBe(content);
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Close", exact: true })).toBeEnabled();
    boxes.editor = editor;
  }
  await testInfo.attach("responsive-layout", {
    body: Buffer.from(JSON.stringify({ viewport, scenario, sidebar, mobileHeader, detail, overflow, controls: boxes }, null, 2)),
    contentType: "application/json",
  });
  testInfo.annotations.push({
    type: "responsive visual comparison",
    description: "Full before/after images retain intentional desktop resize controls, the equal-size mobile header actions and content wrapping changes. The new layout must fit its viewport, retain usable controls and preserve control theme; legacy mobile overflow is not an expected image.",
  });
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
        if (scenario === "text") expect(await settleEditor(after.page)).toEqual(await settleEditor(before.page));
        for (const [label, view] of [["before", before], ["after", after]]) {
          const path = testInfo.outputPath(`${label}.png`);
          if (scenario === "text") await settleEditor(view.page);
          await view.page.screenshot({ path, fullPage: true, animations: "disabled" });
          await testInfo.attach(label, { path, contentType: "image/png" });
        }
        if (mode === "responsive") {
          await assertResponsiveLayout(before, after, scenario, viewport, testInfo);
          return;
        }
        const regions = scenario === "home" && mode === "ui" ? ["#sidebar", ".google-login-container", ".footer"] : [null];
        const masks = [];
        if (scenario === "home" && mode === "ui") {
          const previousBox = await before.page.locator("#tokenInput").boundingBox();
          const currentBox = await after.page.locator("#tokenInput").boundingBox();
          expect(previousBox).not.toBeNull();
          expect(currentBox).not.toBeNull();
          // Original 88fcb28 desktop/mobile screenshots and measured DOM both
          // place the input at y=215. The current PR base removed the label and
          // moved it upward; restore only that y while retaining its geometry.
          expect(currentBox.y).toBe(215);
          expect({ x: currentBox.x, width: currentBox.width, height: currentBox.height }).toEqual({
            x: previousBox.x, width: previousBox.width, height: previousBox.height,
          });
        }
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
        if (scenario === "draft" && mode === "ui") {
          // Empty draft values cannot be copied until a share is published.
          // Keep their geometry and all other pixels under comparison.
          for (const selector of ["#copy-token", "#copy-magnet"]) {
            await expect(before.page.locator(selector)).toBeDisabled();
            await expect(after.page.locator(selector)).toBeDisabled();
            expect(await after.page.locator(selector).boundingBox()).toEqual(await before.page.locator(selector).boundingBox());
          }
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
          const oldControl = before.page.locator('#text-editor-header-right button:last-child');
          const newControl = after.page.locator('#text-editor-header-right button:last-child');
          await expect(oldControl).toBeDisabled();
          await expect(newControl).toBeEnabled();
          const oldOpacity = await oldControl.evaluate(button => getComputedStyle(button).opacity);
          // A viewer's disabled Delete becomes an enabled Close. Its opacity
          // also affects the shadow outside the masked rectangle, so normalize
          // only this known semantic state after keeping the raw screenshots.
          await newControl.evaluate((button, opacity) => {
            button.disabled = true;
            button.style.opacity = opacity;
          }, oldOpacity);
        }
        for (let i = 0; i < regions.length; i++) {
          const selector = regions[i];
          const oldTarget = selector ? before.page.locator(selector) : before.page;
          const newTarget = selector ? after.page.locator(selector) : after.page;
          if (selector) expect(await newTarget.boundingBox()).toEqual(await oldTarget.boundingBox());
          const screenshotOptions = page => ({ animations: "disabled", ...(selector ? {} : { fullPage: true }), mask: masks.map(mask => page.locator(mask)) });
          if (scenario === "text") await settleEditor(before.page);
          const expected = await oldTarget.screenshot(screenshotOptions(before.page));
          const name = `${viewport.name}-${scenario}-${i}.png`;
          const expectedPath = testInfo.snapshotPath(name);
          await mkdir(dirname(expectedPath), { recursive: true });
          await writeFile(expectedPath, expected);
          if (scenario === "text") await settleEditor(after.page);
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
