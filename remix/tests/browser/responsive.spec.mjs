import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test as base, expect } from "@playwright/test";
import Redis from "ioredis";
import { startApplication } from "../helpers.mjs";

const remixRoot = fileURLToPath(new URL("../..", import.meta.url));
const filename = "project-proposal-meeting-final-with-a-long-filename.pdf";
const textTitle = "Responsive shared text";
const test = base.extend({
  application: [async ({ browserName }, use) => {
    expect(["chromium", "webkit"]).toContain(browserName);
    const application = await startApplication();
    try { await use(application); } finally { await application.stop(); }
  }, { scope: "worker" }],
});
const seedTest = test.extend({
  context: async ({ context, browserName, playwright, contextOptions, headless, viewport, isMobile, hasTouch, colorScheme, reducedMotion }, use) => {
    if (browserName !== "webkit") return use(context);
    // WebKit cannot use OPFS in ephemeral contexts. A fresh persistent profile
    // exercises native file storage as in a regular Safari tab, without sharing
    // files or browser state with other tests.
    const profile = await mkdtemp(join(tmpdir(), "w2w-webkit-seed-"));
    let persistentContext;
    try {
      persistentContext = await playwright.webkit.launchPersistentContext(profile, {
        ...contextOptions, headless, viewport, isMobile, hasTouch, colorScheme, reducedMotion,
      });
      // Playwright's context instrumentation also records traces and failure
      // screenshots for launchPersistentContext; do not start a second trace.
      await use(persistentContext);
    } finally {
      try { await persistentContext?.close(); }
      finally { await rm(profile, { recursive: true, force: true }); }
    }
  },
});

async function localAssets(context, application) {
  const origin = new URL(application.baseURL).origin;
  await context.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.origin === origin || ["blob:", "data:"].includes(url.protocol)) return route.continue();
    if (url.pathname.includes("/min/vs/")) {
      const relative = url.pathname.slice(url.pathname.indexOf("/min/vs/") + 8);
      if (!relative.split("/").includes("..")) {
        const path = join(remixRoot, "node_modules/monaco-editor/min/vs", relative);
        try {
          await access(path);
          return route.fulfill({ path, headers: { "Access-Control-Allow-Origin": "*" } });
        } catch { /* Unknown external assets stay blocked. */ }
      }
    }
    return route.abort();
  });
  // Seeding local bytes does not require a remote tracker. Block announcements
  // while keeping the real WebTorrent client, hashing and seed lifecycle.
  await context.routeWebSocket(/^wss?:\/\//, route => route.close());
}

async function fixtures(context, application, { title = textTitle, token } = {}) {
  const publication = await fetch(application.baseURL + "/api/new/token", {
    method: "POST", body: new URLSearchParams({
      intent: "acquireToken", filename, filetype: "application/pdf", filesize: "12345",
      magnet: "magnet:?xt=urn:btih:9876543210abcdef9876543210abcdef98765432&dn=" + encodeURIComponent(filename),
    }),
  });
  expect(publication.status).toBe(200);
  const { share } = await publication.json();
  const creation = await fetch(application.baseURL + "/api/new/text", { method: "POST", redirect: "manual" });
  expect(creation.status).toBe(302);
  const textPath = creation.headers.get("location");
  const content = `# ${title}\nA saved text used to verify the editor does not shrink the sidebar.`;
  const save = await fetch(application.baseURL + textPath, {
    method: "POST", body: new URLSearchParams({ intent: "save", content }),
  });
  expect(save.status).toBe(200);
  const redis = new Redis({ host: application.redis.host, port: application.redis.port });
  let text;
  try {
    const key = "w2w:v2:share:text:" + textPath.split("/").pop();
    text = JSON.parse(await redis.get(key));
    if (token) {
      // Exercise the widest valid token without allocating thousands of shares.
      // Keep the real record and alias consistent for the normal loader/save path.
      const oldToken = text.token;
      text.token = token;
      await redis.multi()
        .del("w2w:v2:token:" + oldToken)
        .set(key, JSON.stringify(text), "KEEPTTL")
        .set("w2w:v2:token:" + token, JSON.stringify({ kind: "text", id: text.id }), "PX", await redis.pttl(key))
        .exec();
    }
  } finally { await redis.quit(); }
  const createdAt = new Date().toISOString();
  await context.addInitScript(({ share, text, createdAt, textTitle }) => {
    if (!localStorage.getItem("w2w.files.v1")) {
      localStorage.setItem("w2w.files.v1", JSON.stringify([{
        id: "responsive-file", shareId: share.id, share, displayName: share.filename,
        notes: "", favorite: false, createdAt, direction: "seed",
      }]));
    }
    if (!localStorage.getItem("w2w.texts.v1")) {
      localStorage.setItem("w2w.texts.v1", JSON.stringify([{
        id: text.id, token: text.token, title: textTitle, lastAccessedAt: text.lastAccessedAt, createdAt,
      }]));
    }
  }, { share, text, createdAt, textTitle: title });
  return { share, textPath, filePath: `/files/${share.id}` };
}

async function editorReady(page) {
  await expect(page.locator(".monaco-editor")).toBeVisible({ timeout: 20000 });
  await page.waitForFunction(() => globalThis.monaco?.editor?.getEditors().length === 1);
}

async function noHorizontalOverflow(page) {
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(page.viewportSize().width);
  await expect.poll(() => page.evaluate(() =>
    Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth,
  )).toBeLessThanOrEqual(1);
  // The shell intentionally clips document overflow. Check its independently
  // scrolling content pane too, so a wide dropzone cannot hide off-screen.
  await expect.poll(() => page.locator("#detail").evaluate(element =>
    element.scrollWidth - element.clientWidth,
  )).toBeLessThanOrEqual(1);
}

async function insideContentWidth(page, locator) {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  const content = await page.locator("#detail").boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(content.x - 1);
  expect(box.x + box.width).toBeLessThanOrEqual(content.x + content.width + 1);
}

async function insideViewport(page, locator) {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  const viewport = page.viewportSize();
  expect(box.x).toBeGreaterThanOrEqual(-1);
  expect(box.y).toBeGreaterThanOrEqual(-1);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
}

async function capture(page, testInfo, name) {
  const path = testInfo.outputPath(name + ".png");
  await page.screenshot({ path, fullPage: true, animations: "disabled" });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

async function sidebarWidth(page) { return (await page.locator("#sidebar").boundingBox()).width; }

// These viewports run in touch contexts, so short landscape screens also use
// the phone navigation even when their width exceeds the portrait breakpoint.
const phoneViewport = ({ width, height }) => width < 768 || (width <= 1023 && height <= 500);

async function phoneShell(page) {
  await expect(page.locator("#sidebar")).toBeHidden();
  const header = page.locator("#mobile-header");
  await insideViewport(page, header);
  expect((await header.boundingBox()).height).toBeCloseTo(56, 0);
  const detail = await page.locator("#detail").boundingBox();
  expect(detail.x).toBeCloseTo(0, 0);
  expect(detail.width).toBeCloseTo(page.viewportSize().width, 0);
  const search = page.locator("#mobile-search");
  const create = page.locator("#mobile-new");
  for (const control of [search, create]) {
    await insideViewport(page, control);
    const box = await control.boundingBox();
    expect(box.width).toBe(44);
    expect(box.height).toBe(44);
  }
  expect((await search.boundingBox()).y).toBeCloseTo((await create.boundingBox()).y, 0);
  const shape = element => {
    const style = getComputedStyle(element);
    return { padding: style.padding, borderWidth: style.borderWidth, borderRadius: style.borderRadius, fontSize: style.fontSize };
  };
  expect(await search.evaluate(shape)).toEqual(await create.evaluate(shape));
  return detail;
}

async function dragSidebar(page, width) {
  const box = await page.getByRole("separator", { name: "Resize sidebar" }).boundingBox();
  expect(box).not.toBeNull();
  const startX = box.x + box.width / 2;
  const targetX = startX + width - await sidebarWidth(page);
  const y = box.y + Math.min(120, box.height / 2);
  await page.mouse.move(startX, y);
  await page.mouse.down();
  await page.mouse.move(targetX, y, { steps: 12 });
  await page.mouse.up();
}

test.describe("responsive layout", () => {
  test.use({ viewport: { width: 1440, height: 1000 } });
  test.beforeEach(async ({ context, application }) => {
    test.setTimeout(90000);
    await localAssets(context, application);
  });

  test("desktop sidebar resizes, collapses to typed icons and keeps its width in the text editor", async ({ page, context, application, browserName }, testInfo) => {
    const fixture = await fixtures(context, application);
    await page.goto(application.baseURL + fixture.filePath);
    const sidebar = page.locator("#sidebar");
    await expect(sidebar).toHaveAttribute("data-collapsed", "false");
    await expect.poll(() => sidebarWidth(page)).toBeCloseTo(288, 0);
    await dragSidebar(page, 400);
    await expect.poll(() => sidebarWidth(page)).toBeGreaterThan(385);
    const expandedWidth = await sidebarWidth(page);
    await page.locator(`#sidebar nav a[href="${fixture.textPath}"]`).click();
    await editorReady(page);
    expect(await sidebarWidth(page)).toBeCloseTo(expandedWidth, 0);
    await insideViewport(page, page.getByRole("button", { name: "Save", exact: true }));
    await insideViewport(page, page.getByRole("button", { name: "Close", exact: true }));
    await noHorizontalOverflow(page);
    await capture(page, testInfo, `${browserName}-desktop-expanded-text`);

    await dragSidebar(page, 8);
    await expect(sidebar).toHaveAttribute("data-collapsed", "true");
    await expect.poll(() => sidebarWidth(page)).toBeCloseTo(64, 0);
    const collapsedSearch = page.locator("#sidebar .sidebar-search-button");
    const collapsedNew = page.locator("#sidebar .sidebar-new-form button");
    for (const control of [collapsedSearch, collapsedNew]) {
      await expect(control).toBeVisible();
      const box = await control.boundingBox();
      expect({ width: box.width, height: box.height }).toEqual({ width: 44, height: 44 });
    }
    expect((await collapsedNew.boundingBox()).x).toBe((await collapsedSearch.boundingBox()).x);
    const fileLink = page.locator(`#sidebar nav a[href="${fixture.filePath}"]`);
    await expect(fileLink.locator(".sidebar-file-icon.fa-file-pdf")).toBeVisible();
    await expect(fileLink.locator(".sidebar-entry-label")).toBeHidden();
    await expect(page.locator(`#sidebar nav a[href="${fixture.textPath}"] .sidebar-file-icon.fa-file-code`)).toBeVisible();
    await fileLink.hover();
    await expect(page.getByRole("tooltip")).toContainText(filename);
    await capture(page, testInfo, `${browserName}-desktop-collapsed-tooltip`);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    await page.mouse.move(800, 800);
    await fileLink.focus();
    await expect(page.getByRole("tooltip")).toContainText(filename);
    await page.keyboard.press("Escape");
    await page.reload();
    await editorReady(page);
    await expect(sidebar).toHaveAttribute("data-collapsed", "true");
    expect(await sidebarWidth(page)).toBeCloseTo(64, 0);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("w2w.sidebar.v1")).collapsed)).toBe(true);

    await dragSidebar(page, 320);
    await expect(sidebar).toHaveAttribute("data-collapsed", "false");
    await expect.poll(() => sidebarWidth(page)).toBeGreaterThan(300);
    const separator = page.getByRole("separator", { name: "Resize sidebar" });
    await separator.focus();
    await separator.press("Home");
    await expect(sidebar).toHaveAttribute("data-collapsed", "true");
    await separator.press("ArrowRight");
    await expect(sidebar).toHaveAttribute("data-collapsed", "false");
    expect(await sidebarWidth(page)).toBeGreaterThanOrEqual(200);
    const restoredWidth = await sidebarWidth(page);
    await page.getByRole("link", { name: "Home", exact: true }).click();
    expect(await sidebarWidth(page)).toBeCloseTo(restoredWidth, 0);
    await noHorizontalOverflow(page);
  });

  test("long text titles yield to toolbar controls at narrow and zoomed desktop widths", async ({ page, context, application, browserName }, testInfo) => {
    const title = "A very long shared text title that should truncate before it can displace controls".slice(0, 80);
    const fixture = await fixtures(context, application, { title, token: "654321" });
    await page.goto(application.baseURL + fixture.textPath);
    await editorReady(page);
    const titleInput = page.getByRole("textbox", { name: "Text title from content", exact: true });
    const tokenInput = page.getByRole("textbox", { name: "Token", exact: true });
    await expect(titleInput).toHaveValue(title);
    await expect(titleInput).toHaveAttribute("readonly", "");
    await expect(tokenInput).toHaveValue("654321");
    const controls = [
      ["title", titleInput], ["token", tokenInput],
      ["copy", page.getByRole("button", { name: "Copy", exact: true })],
      ["language", page.getByRole("combobox", { name: "Select programming language" })],
      ["save", page.getByRole("button", { name: "Save", exact: true })],
      ["close", page.getByRole("button", { name: "Close", exact: true })],
    ];
    const measureText = element => {
      const style = getComputedStyle(element);
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");
      context.font = style.font;
      return {
        textWidth: context.measureText(element.value).width,
        availableWidth: element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
        overflow: style.textOverflow,
      };
    };
    const assertToolbar = async () => {
      await noHorizontalOverflow(page);
      const boxes = [];
      for (const [name, control] of controls) {
        await insideViewport(page, control);
        await insideContentWidth(page, control);
        let box = await control.boundingBox();
        if (name === "token") {
          // Copy intentionally sits in the token's right padding. Its hit target
          // must not cover the actual six digits or any other toolbar control.
          box = await control.evaluate(element => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            const scale = rect.width / element.offsetWidth;
            const left = (parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft)) * scale;
            const right = (parseFloat(style.borderRightWidth) + parseFloat(style.paddingRight)) * scale;
            return { x: rect.x + left, y: rect.y, width: rect.width - left - right, height: rect.height };
          });
        }
        boxes.push({ name, ...box });
      }
      for (let i = 0; i < boxes.length; i++) {
        for (const next of boxes.slice(i + 1)) {
          const current = boxes[i];
          const horizontal = Math.min(current.x + current.width, next.x + next.width) - Math.max(current.x, next.x);
          const vertical = Math.min(current.y + current.height, next.y + next.height) - Math.max(current.y, next.y);
          expect(horizontal > 1 && vertical > 1, `${current.name} overlaps ${next.name}`).toBe(false);
        }
      }
      const titleMetrics = await titleInput.evaluate(measureText);
      expect(titleMetrics.overflow).toBe("ellipsis");
      expect(titleMetrics.availableWidth).toBeGreaterThan(0);
      expect(titleMetrics.textWidth).toBeGreaterThan(titleMetrics.availableWidth);
      const tokenMetrics = await tokenInput.evaluate(measureText);
      expect(tokenMetrics.textWidth).toBeLessThanOrEqual(tokenMetrics.availableWidth + 1);
      const editorWidth = await page.locator("#text-editor-container").evaluate(element => element.clientWidth);
      const center = box => box.y + box.height / 2;
      if (editorWidth > 640) {
        for (const box of boxes) expect(Math.abs(center(box) - center(boxes[0])), `${box.name} remains on the first row`).toBeLessThanOrEqual(2);
      } else {
        expect(boxes.find(box => box.name === "save").y).toBeGreaterThanOrEqual(boxes[0].y + boxes[0].height);
      }
    };
    // Narrow CSS viewports model the usable space remaining after browser zoom;
    // resizing the sidebar also proves the breakpoint follows the editor itself.
    for (const width of [1100, 1000]) {
      await page.setViewportSize({ width, height: 900 });
      for (const sidebar of [200, 288, 480, 64]) {
        await test.step(`viewport ${width}, sidebar ${sidebar}`, async () => {
          await dragSidebar(page, sidebar === 64 ? 8 : sidebar);
          await expect.poll(() => sidebarWidth(page)).toBeCloseTo(sidebar, 0);
          await assertToolbar();
          if ((width === 1100 && sidebar === 288) || (width === 1000 && sidebar === 480)) {
            await capture(page, testInfo, `${browserName}-long-toolbar-${width}-sidebar-${sidebar}`);
          }
        });
      }
    }
    await page.setViewportSize({ width: 1100, height: 900 });
    await dragSidebar(page, 288);
    await page.evaluate(() => { document.documentElement.style.zoom = "1.1"; });
    await test.step("110 percent layout zoom", async () => {
      await assertToolbar();
      await capture(page, testInfo, `${browserName}-long-toolbar-110-percent`);
    });
  });

  test.describe("touch viewports", () => {
    test.use({ isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 } });

    test("phone, landscape and tablet pages fit without squeezing the sidebar", async ({ page, context, application, browserName }, testInfo) => {
      const fixture = await fixtures(context, application);
      for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }, { width: 1024, height: 768 }]) {
        await page.setViewportSize(viewport);
        await page.goto(application.baseURL + fixture.filePath);
        const phone = phoneViewport(viewport);
        if (phone) await phoneShell(page);
        else await expect.poll(() => sidebarWidth(page)).toBeCloseTo(288, 0);
        await noHorizontalOverflow(page);
        await insideViewport(page, page.getByRole("button", { name: "Seed", exact: true }));
        await capture(page, testInfo, `${browserName}-file-${viewport.width}x${viewport.height}`);
        if (phone) {
          const originalDetail = await page.locator("#detail").boundingBox();
          await page.locator("#mobile-sidebar-toggle").click();
          await expect(page.locator("#sidebar")).toHaveAttribute("data-mobile-open", "true");
          await expect.poll(() => sidebarWidth(page)).toBeCloseTo(Math.min(320, viewport.width - 48), 0);
          expect(await page.locator("#detail").boundingBox()).toEqual(originalDetail);
          await expect(page.getByRole("searchbox", { name: "Search files" })).toBeVisible();
          await expect(page.locator(".sidebar-backdrop")).toBeVisible();
          await page.touchscreen.tap(viewport.width - 10, Math.floor(viewport.height / 2));
          await expect(page.locator("#sidebar")).toHaveAttribute("data-mobile-open", "false");
          await page.locator("#mobile-search").click();
          await expect(page.locator("#q")).toBeFocused();
          expect(await page.locator("#detail").boundingBox()).toEqual(originalDetail);
          await page.keyboard.press("Escape");
          await expect(page.locator("#sidebar")).toHaveAttribute("data-mobile-open", "false");
          await expect(page.locator("#mobile-search")).toBeFocused();
          await page.locator("#mobile-sidebar-toggle").click();
        }
        await page.locator(`#sidebar nav a[href="${fixture.textPath}"]`).click();
        await editorReady(page);
        await expect(page.locator("#sidebar")).toHaveAttribute("data-mobile-open", "false");
        if (phone) await phoneShell(page);
        else expect(await sidebarWidth(page)).toBeCloseTo(288, 0);
        await insideViewport(page, page.getByRole("button", { name: "Save", exact: true }));
        await insideViewport(page, page.getByRole("button", { name: "Close", exact: true }));
        await insideViewport(page, page.getByRole("combobox", { name: "Select programming language" }));
        const editorBox = await page.locator("#text-editor-wrapper").boundingBox();
        expect(editorBox.width).toBeGreaterThan(200);
        expect(editorBox.height).toBeGreaterThan(100);
        await noHorizontalOverflow(page);
        await capture(page, testInfo, `${browserName}-text-${viewport.width}x${viewport.height}`);
        await page.getByRole("link", { name: "Home", exact: true }).click();
        await insideViewport(page, page.getByRole("textbox", { name: "Share token", exact: true }));
        await noHorizontalOverflow(page);
        if (phone) {
          await phoneShell(page);
          await capture(page, testInfo, `${browserName}-home-toolbar-${viewport.width}x${viewport.height}`);
        }
        await page.getByRole("button", { name: "New", exact: true }).click();
        await insideViewport(page, page.getByRole("button", { name: /New File/ }));
        await noHorizontalOverflow(page);
        await page.getByRole("button", { name: /New File/ }).click();
        await expect(page.locator("#dropzone")).toBeVisible();
        await noHorizontalOverflow(page);
        for (const control of [
          page.locator("#dropzone"),
          page.getByRole("textbox", { name: "Filename", exact: true }),
          page.getByRole("textbox", { name: "Token", exact: true }),
          page.getByRole("textbox", { name: "File Link", exact: true }),
          page.getByRole("textbox", { name: "Notes", exact: true }),
        ]) await insideContentWidth(page, control);
      }

      // The mobile redesign must keep the text lifecycle usable through its
      // actual controls, not just fit static editor fixtures into the viewport.
      await page.setViewportSize({ width: 390, height: 844 });
      await page.locator("#mobile-new").click();
      await page.getByRole("button", { name: /New Text/ }).click();
      await editorReady(page);
      await page.evaluate(() => globalThis.monaco.editor.getEditors()[0].setValue("# Mobile saved note\nSaved from the phone toolbar."));
      const savedPath = new URL(page.url()).pathname;
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByRole("button", { name: "Close", exact: true })).toBeVisible();
      await capture(page, testInfo, `${browserName}-phone-saved-text-editor`);
      await page.locator("#mobile-sidebar-toggle").click();
      const savedLink = page.locator(`#sidebar nav a[href="${savedPath}"]`);
      await expect(savedLink).toBeVisible();
      await expect(savedLink).toContainText("Mobile saved note");
      await capture(page, testInfo, `${browserName}-phone-saved-text-history`);
      await page.locator("#sidebar-toggle").click();
      await expect(page.locator("#sidebar")).toBeHidden();

      await page.locator("#mobile-new").click();
      await page.getByRole("button", { name: /New Text/ }).click();
      await editorReady(page);
      const cancelledToken = await page.getByRole("textbox", { name: "Token", exact: true }).inputValue();
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(page).toHaveURL(application.baseURL + "/");
      const lookup = await page.request.post(application.baseURL + "/api/new/token", {
        form: { intent: "acquireMagnet", token: cancelledToken },
      });
      expect((await lookup.json()).type).toBeNull();
    });

    seedTest("real mobile seeding stays fixed and visible with versioned styles", async ({ page, context, application, browserName }, testInfo) => {
      const browserEvents = [];
      const record = event => { if (browserEvents.length < 100) browserEvents.push(event); };
      page.on("pageerror", error => record({ type: "pageerror", message: error.message, stack: error.stack }));
      page.on("console", message => {
        if (["error", "warning"].includes(message.type())) {
          record({ type: message.type(), message: message.text() });
        }
      });
      page.on("worker", worker => {
        record({ type: "worker", url: worker.url() });
        worker.on("close", () => record({ type: "worker-close", url: worker.url() }));
      });
      let legacyStyleRequests = 0;
      await context.route(/\/css\/(app|text-editor)\.css(?:\?.*)?$/, route => {
        legacyStyleRequests++;
        return route.fulfill({ contentType: "text/css", body: "body { display: flex; } #sidebar { width: 18rem; }" });
      });
      await page.goto(application.baseURL + "/new");
      await page.getByRole("button", { name: /New File/ }).click();
      try {
        const [published] = await Promise.all([
          page.waitForResponse(response => /\/api\/[^/]+\/token/.test(new URL(response.url()).pathname)
            && response.request().method() === "POST" && response.request().postData()?.includes("acquireToken"), { timeout: 30000 }),
          page.locator("#fileInput").setInputFiles({
            name: `${browserName}-mobile-seed.txt`, mimeType: "text/plain",
            buffer: Buffer.from("Actual mobile seeding fixture.\n".repeat(2048)),
          }),
        ]);
        expect(published.status()).toBe(200);
      } catch (error) {
        const diagnostics = await page.evaluate(async () => {
          const probe = async operation => {
            try {
              return await Promise.race([
                operation().then(() => "success"),
                new Promise(resolve => setTimeout(() => resolve("timed out"), 3000)),
              ]);
            } catch (error) { return { name: error.name, message: error.message, stack: error.stack }; }
          };
          const probes = {
            sha1: await probe(() => crypto.subtle.digest("SHA-1", new TextEncoder().encode("W2W seed diagnostic"))),
            opfs: await probe(() => navigator.storage.getDirectory()),
          };
          return { userAgent: navigator.userAgent, probes, capabilities: {
            secureContext: isSecureContext, opfs: !!navigator.storage?.getDirectory,
            nativeWritable: !!globalThis.FileSystemFileHandle?.prototype.createWritable,
          },
            transferStatus: document.querySelector(".transfer-status")?.textContent,
          };
        }).catch(error => ({ collectionError: error.message }));
        await testInfo.attach("real-seeding-diagnostics", {
          body: JSON.stringify({ browserEvents, ...diagnostics }, null, 2), contentType: "application/json",
        });
        throw error;
      }
      await expect(page.locator('.transfer-status-label [role="status"]')).toContainText("Seeding");
      expect(legacyStyleRequests).toBe(0);
      const styles = await page.locator('link[rel="stylesheet"]').evaluateAll(links => links.map(link => new URL(link.href).pathname));
      expect(styles.some(path => /^\/assets\/app-[^/]+\.css$/.test(path))).toBe(true);
      expect(styles.some(path => /^\/assets\/text-editor-[^/]+\.css$/.test(path))).toBe(true);
      for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }, { width: 1024, height: 768 }]) {
        await page.setViewportSize(viewport);
        const status = page.locator(".transfer-status");
        expect(await status.evaluate(element => getComputedStyle(element).position)).toBe("fixed");
        await insideViewport(page, page.locator(".transfer-status-label"));
        await insideViewport(page, page.locator(".transfer-tape--top"));
        await insideViewport(page, page.locator(".transfer-tape--bottom"));
        expect((await page.locator(".transfer-tape--top").boundingBox()).width).toBeGreaterThanOrEqual(viewport.width - 2);
        if (phoneViewport(viewport)) {
          await phoneShell(page);
          await expect(page.locator(".transfer-status-hint")).toBeHidden();
        } else {
          expect((await page.locator("#sidebar").boundingBox()).x).toBeCloseTo(0, 0);
          expect((await page.locator("#detail").boundingBox()).x).toBeCloseTo(await sidebarWidth(page), 0);
        }
        await noHorizontalOverflow(page);
        await capture(page, testInfo, `${browserName}-seeding-${viewport.width}x${viewport.height}`);
      }
      await page.setViewportSize({ width: 390, height: 844 });
      const pause = page.getByRole("button", { name: "Pause transfer animation", exact: true });
      await insideViewport(page, pause);
      const pauseBox = await pause.boundingBox();
      await page.touchscreen.tap(pauseBox.x + pauseBox.width / 2, pauseBox.y + pauseBox.height / 2);
      await expect(page.locator(".transfer-status")).toContainText("Seeding");
      expect(await page.locator(".transfer-tape--top").evaluate(element => getComputedStyle(element, "::before").animationPlayState)).toBe("paused");
      await page.getByRole("link", { name: "Home", exact: true }).click();
      await expect(page.locator(".transfer-status")).toContainText("Seeding");
      await page.emulateMedia({ reducedMotion: "reduce" });
      expect(await page.locator(".transfer-tape--top").evaluate(element => getComputedStyle(element, "::before").animationName)).toBe("none");
      await expect(page.getByRole("button", { name: "Resume transfer animation", exact: true })).toBeHidden();
    });
  });
});
