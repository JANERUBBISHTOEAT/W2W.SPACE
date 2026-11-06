import { access } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test as base, expect } from "@playwright/test";
import Redis from "ioredis";
import { startApplication } from "../helpers.mjs";

const remixRoot = fileURLToPath(new URL("../..", import.meta.url));
const historyKey = "w2w.texts.v1";
const test = base.extend({
  application: [async ({ browserName }, use) => {
    expect(browserName).toBe("chromium");
    const application = await startApplication();
    try { await use(application); } finally { await application.stop(); }
  }, { scope: "worker" }],
  redis: async ({ application }, use) => {
    const redis = new Redis({ host: application.redis.host, port: application.redis.port });
    try { await use(redis); } finally { await redis.quit(); }
  },
});

async function localEditorAssets(context, application) {
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
        } catch { /* Other external resources remain blocked. */ }
      }
    }
    return route.abort();
  });
}

async function editorReady(page) {
  await expect(page.locator(".monaco-editor")).toBeVisible({ timeout: 20000 });
  await page.waitForFunction(() => globalThis.monaco?.editor?.getEditors().length === 1);
}

async function createText(page, application) {
  await page.goto(application.baseURL + "/new");
  await page.getByRole("button", { name: /New Text/ }).click();
  await expect(page).toHaveURL(/\/texts\/[a-f\d-]{36}$/);
  await editorReady(page);
  await expect(page.getByRole("button", { name: "Cancel", exact: true })).toBeVisible();
  const path = new URL(page.url()).pathname;
  const token = await page.getByRole("textbox", { name: "Token", exact: true }).inputValue();
  expect(token).toMatch(/^\d{1,6}$/);
  return { path, id: path.split("/").pop(), token };
}

async function setContent(page, content) {
  await page.evaluate(value => globalThis.monaco.editor.getEditors()[0].setValue(value), content);
  await expect.poll(() => page.evaluate(() => globalThis.monaco.editor.getEditors()[0].getValue())).toBe(content);
}

async function history(page) {
  return page.evaluate(key => JSON.parse(localStorage.getItem(key) || "[]"), historyKey);
}

const textLink = (page, text) => page.locator(`#sidebar nav a[href="${text.path}"]`);

test.beforeEach(async ({ context, application }) => {
  test.setTimeout(60000);
  await localEditorAssets(context, application);
});

test("Cancel removes a new text and releases its token without creating history", async ({ page, application, redis }, testInfo) => {
  const text = await createText(page, application);
  const draftScreenshot = testInfo.outputPath("new-text-draft.png");
  await page.screenshot({ path: draftScreenshot, fullPage: true });
  await testInfo.attach("new-text-draft", { path: draftScreenshot, contentType: "image/png" });
  expect(await redis.exists(`w2w:v2:share:text:${text.id}`, `w2w:v2:token:${text.token}`)).toBe(2);
  await setContent(page, "This unsaved text should be discarded.");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page).toHaveURL(application.baseURL + "/");
  expect(await redis.exists(`w2w:v2:share:text:${text.id}`, `w2w:v2:token:${text.token}`)).toBe(0);
  const lookup = await page.request.post(application.baseURL + "/api/new/token", {
    form: { intent: "acquireMagnet", token: text.token },
  });
  expect((await lookup.json()).type).toBeNull();
  expect(await history(page)).toEqual([]);
  await expect(textLink(page, text)).toHaveCount(0);
});

test("Save and Ctrl+S keep one browser-local sidebar entry that survives Close and reload", async ({ page, context, browser, application, redis }, testInfo) => {
  const text = await createText(page, application);
  const firstContent = "# Saved browser note\nFirst saved content.";
  await setContent(page, firstContent);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(textLink(page, text)).toContainText(`Saved browser note #${text.token}`);
  await expect(page.getByRole("button", { name: "Close", exact: true })).toBeVisible();
  await expect.poll(async () => (await history(page)).length).toBe(1);
  const firstRecord = (await history(page))[0];
  expect(firstRecord.id).toBe(text.id);
  expect(firstRecord.token).toBe(text.token);
  expect(firstRecord).not.toHaveProperty("content");
  const savedScreenshot = testInfo.outputPath("saved-text-sidebar.png");
  await page.screenshot({ path: savedScreenshot, fullPage: true });
  await testInfo.attach("saved-text-sidebar", { path: savedScreenshot, contentType: "image/png" });

  const updatedContent = "# Renamed browser note\nSaved through the keyboard shortcut.";
  await setContent(page, updatedContent);
  await page.evaluate(() => globalThis.monaco.editor.getEditors()[0].focus());
  await page.keyboard.press("Control+s");
  await expect(textLink(page, text)).toContainText(`Renamed browser note #${text.token}`);
  expect(await history(page)).toHaveLength(1);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page).toHaveURL(application.baseURL + "/");
  const stored = JSON.parse(await redis.get(`w2w:v2:share:text:${text.id}`));
  expect(stored.content).toBe(updatedContent);
  expect(stored).not.toHaveProperty("draft");
  expect(JSON.parse(await redis.get(`w2w:v2:token:${text.token}`))).toEqual({ kind: "text", id: text.id });

  await page.reload();
  await expect(textLink(page, text)).toContainText("Renamed browser note");
  await textLink(page, text).click();
  await editorReady(page);
  expect(await page.evaluate(() => globalThis.monaco.editor.getEditors()[0].getValue())).toBe(updatedContent);
  await expect(page.getByRole("button", { name: "Close", exact: true })).toBeVisible();
  const secondTab = await context.newPage();
  await secondTab.goto(application.baseURL + "/");
  await expect(textLink(secondTab, text)).toContainText("Renamed browser note");
  await secondTab.close();

  const otherBrowser = await browser.newContext();
  try {
    await localEditorAssets(otherBrowser, application);
    const otherPage = await otherBrowser.newPage();
    await otherPage.goto(application.baseURL + "/");
    await expect(textLink(otherPage, text)).toHaveCount(0);
    expect(await history(otherPage)).toEqual([]);
  } finally { await otherBrowser.close(); }
});

test("a failed Save does not create a sidebar record", async ({ page, application, redis }) => {
  const text = await createText(page, application);
  await setContent(page, "# A text that expires before Save");
  // Exercise the actual server's expiry failure, not a mocked action response.
  await redis.del(`w2w:v2:share:text:${text.id}`, `w2w:v2:token:${text.token}`);
  const response = page.waitForResponse(response => response.request().method() === "POST"
    && new URL(response.url()).pathname === text.path + ".data"
    && response.request().postData()?.includes("save"));
  await page.getByRole("button", { name: "Save", exact: true }).click();
  expect((await response).status()).toBe(404);
  await expect(page.getByText("This text share has expired", { exact: true })).toBeVisible();
  expect(await history(page)).toEqual([]);
  await expect(textLink(page, text)).toHaveCount(0);
  expect(await redis.exists(`w2w:v2:share:text:${text.id}`)).toBe(0);
});

test("a stale creator's Cancel cannot delete text saved in another tab", async ({ page, context, application, redis }) => {
  const text = await createText(page, application);
  const reader = await context.newPage();
  await reader.goto(application.baseURL + text.path);
  await editorReady(reader);
  await setContent(reader, "# Saved from another tab\nKeep this shared content.");
  await reader.getByRole("button", { name: "Save", exact: true }).click();
  await expect(textLink(reader, text)).toContainText("Saved from another tab");
  // The creator still has its original draft loader snapshot.
  await expect(page.getByRole("button", { name: "Cancel", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page).toHaveURL(application.baseURL + "/");
  const stored = JSON.parse(await redis.get(`w2w:v2:share:text:${text.id}`));
  expect(stored.content).toContain("Keep this shared content.");
  expect(stored).not.toHaveProperty("draft");
  expect(JSON.parse(await redis.get(`w2w:v2:token:${text.token}`))).toEqual({ kind: "text", id: text.id });
  await expect(textLink(page, text)).toContainText("Saved from another tab");
  await reader.close();
});
