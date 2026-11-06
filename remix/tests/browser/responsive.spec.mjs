import { access } from "node:fs/promises";
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

async function fixtures(context, application) {
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
  const content = `# ${textTitle}\nA saved text used to verify the editor does not shrink the sidebar.`;
  const save = await fetch(application.baseURL + textPath, {
    method: "POST", body: new URLSearchParams({ intent: "save", content }),
  });
  expect(save.status).toBe(200);
  const redis = new Redis({ host: application.redis.host, port: application.redis.port });
  let text;
  try { text = JSON.parse(await redis.get("w2w:v2:share:text:" + textPath.split("/").pop())); }
  finally { await redis.quit(); }
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
  }, { share, text, createdAt, textTitle });
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

async function dragSidebar(page, x) {
  const box = await page.getByRole("separator", { name: "Resize sidebar" }).boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box.x + box.width / 2, box.y + Math.min(120, box.height / 2));
  await page.mouse.down();
  await page.mouse.move(x, box.y + Math.min(120, box.height / 2), { steps: 12 });
  await page.mouse.up();
}

for (const browserName of ["chromium", "webkit"]) {
  test.describe(`${browserName} responsive layout`, () => {
    test.use({ browserName, viewport: { width: 1440, height: 1000 } });
    test.beforeEach(async ({ context, application }) => {
      test.setTimeout(90000);
      await localAssets(context, application);
    });

    test("desktop sidebar resizes, collapses to typed icons and keeps its width in the text editor", async ({ page, context, application }, testInfo) => {
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

    test.describe("touch viewports", () => {
      test.use({ isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 } });

      test("phone, landscape and tablet pages fit without squeezing the sidebar", async ({ page, context, application }, testInfo) => {
        const fixture = await fixtures(context, application);
        for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }, { width: 1024, height: 768 }]) {
          await page.setViewportSize(viewport);
          await page.goto(application.baseURL + fixture.filePath);
          const expectedWidth = viewport.width < 768 ? 64 : 288;
          await expect.poll(() => sidebarWidth(page)).toBeCloseTo(expectedWidth, 0);
          await noHorizontalOverflow(page);
          await insideViewport(page, page.getByRole("button", { name: "Seed", exact: true }));
          if (viewport.width < 768) {
            await page.locator("#sidebar-toggle").click();
            await expect(page.locator("#sidebar")).toHaveAttribute("data-mobile-open", "true");
            await expect(page.getByRole("searchbox", { name: "Search files" })).toBeVisible();
            await expect(page.getByRole("button", { name: "Close sidebar", exact: true })).toBeVisible();
            await page.touchscreen.tap(viewport.width - 10, Math.floor(viewport.height / 2));
            await expect(page.locator("#sidebar")).toHaveAttribute("data-mobile-open", "false");
            await page.locator("#sidebar-toggle").click();
            await page.keyboard.press("Escape");
            await expect(page.locator("#sidebar")).toHaveAttribute("data-mobile-open", "false");
            await page.locator("#sidebar-toggle").click();
          }
          await page.locator(`#sidebar nav a[href="${fixture.textPath}"]`).click();
          await editorReady(page);
          await expect(page.locator("#sidebar")).toHaveAttribute("data-mobile-open", "false");
          expect(await sidebarWidth(page)).toBeCloseTo(expectedWidth, 0);
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
      });

      test("real mobile seeding stays fixed and visible with versioned styles", async ({ page, context, application }, testInfo) => {
        let legacyStyleRequests = 0;
        await context.route(/\/css\/(app|text-editor)\.css(?:\?.*)?$/, route => {
          legacyStyleRequests++;
          return route.fulfill({ contentType: "text/css", body: "body { display: flex; } #sidebar { width: 18rem; }" });
        });
        await page.goto(application.baseURL + "/new");
        await page.getByRole("button", { name: /New File/ }).click();
        const published = page.waitForResponse(response => /\/api\/[^/]+\/token/.test(new URL(response.url()).pathname)
          && response.request().method() === "POST" && response.request().postData()?.includes("acquireToken"));
        await page.locator("#fileInput").setInputFiles({
          name: `${browserName}-mobile-seed.txt`, mimeType: "text/plain",
          buffer: Buffer.from("Actual mobile seeding fixture.\n".repeat(2048)),
        });
        expect((await published).status()).toBe(200);
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
          expect((await page.locator("#sidebar").boundingBox()).x).toBeCloseTo(0, 0);
          expect((await page.locator("#detail").boundingBox()).x).toBeCloseTo(await sidebarWidth(page), 0);
          await noHorizontalOverflow(page);
          await capture(page, testInfo, `${browserName}-seeding-${viewport.width}x${viewport.height}`);
        }
        await page.getByRole("button", { name: "Pause transfer animation", exact: true }).click();
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
}
