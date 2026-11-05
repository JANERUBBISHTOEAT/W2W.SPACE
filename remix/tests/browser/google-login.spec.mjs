import { test as base, expect } from "@playwright/test";
import { startApplication } from "../helpers.mjs";

const test = base.extend({
  application: [async ({ browserName }, use) => {
    expect(browserName).toBe("chromium");
    const application = await startApplication();
    try { await use(application); } finally { await application.stop(); }
  }, { scope: "worker" }],
});

// Exercise the real React component and application routes without asking
// Google for an identity or sending traffic to counters/other external hosts.
const googleScript = `(() => {
  const state = window.googleLoginTest = { initializations: [], renders: [], current: null };
  window.google = { accounts: { id: {
    initialize(config) { state.current = config; state.initializations.push({ nonce: config.nonce }); },
    renderButton(container) {
      const generation = state.renders.length + 1;
      const config = state.current;
      state.renders.push({ nonce: config.nonce, generation });
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Sign in with Google";
      button.className = "mock-google-login";
      button.dataset.generation = String(generation);
      button.onclick = () => config.callback({ credential: "invalid-browser-test-credential" });
      container.replaceChildren(button);
    },
    cancel() {}, disableAutoSelect() {},
    prompt() { throw new Error("Real Google login must not run in this test"); }
  } } };
})();`;

async function mockNetwork(context, application, failures = []) {
  const state = { challengeRequests: 0, callbackNonces: [], pageErrors: [], blockedExternal: [] };
  const observePage = (page) => page.on("pageerror", (error) => state.pageErrors.push(error.message));
  context.pages().forEach(observePage);
  context.on("page", observePage);
  const origin = new URL(application.baseURL).origin;
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === origin) {
      if (url.pathname === "/api/auth/google/challenge") {
        expect(request.method()).toBe("POST");
        state.challengeRequests++;
        const failure = failures.shift();
        if (failure === "network") return route.abort("failed");
        if (failure === "html") return route.fulfill({
          status: 502, contentType: "text/html", body: "<!doctype html><h1>Bad Gateway</h1>",
        });
        if (failure === "json") return route.fulfill({
          status: 503, contentType: "application/json",
          body: JSON.stringify({ error: "Google login is temporarily unavailable. Please try again." }),
        });
        if (failure === "empty-error") return route.fulfill({
          status: 503, contentType: "application/json", body: JSON.stringify({ error: "" }),
        });
        if (failure === "missing-nonce") return route.fulfill({
          status: 200, contentType: "application/json", body: JSON.stringify({ expiresIn: 600 }),
        });
        if (failure === "invalid-lifetime") return route.fulfill({
          status: 200, contentType: "application/json", body: JSON.stringify({ nonce: "A".repeat(43), expiresIn: 0 }),
        });
      }
      if (request.method() === "POST") {
        const form = new URLSearchParams(request.postData() || "");
        if (form.get("intent") === "OAuthCallback") state.callbackNonces.push(form.get("nonce"));
      }
      return route.continue();
    }
    if (url.hostname === "accounts.google.com" && url.pathname === "/gsi/client") {
      return route.fulfill({ contentType: "application/javascript", body: googleScript });
    }
    state.blockedExternal.push(url.hostname);
    return route.abort();
  });
  return state;
}

async function initializedNonce(page) {
  await expect(page.locator(".mock-google-login")).toBeVisible();
  return page.evaluate(() => window.googleLoginTest.current.nonce);
}

async function expectMainUsable(page) {
  await expect(page.locator("#sidebar")).toBeVisible();
  const input = page.getByRole("textbox", { name: "Share token", exact: true });
  await input.fill("000000");
  const result = page.waitForResponse((response) =>
    new URL(response.url()).pathname.startsWith("/api/new/token") && response.request().method() === "POST");
  await input.press("Enter");
  expect((await result).status()).toBe(200);
  await expect(input).toBeVisible();
  await expect(input).toBeEditable();
  await page.getByRole("searchbox", { name: "Search files" }).fill("browser recovery");
  await expect(page).toHaveURL(/[?&]q=browser(?:\+|%20)recovery/);
  await expect(page.locator("#sidebar")).toBeVisible();
  await expect(input).toBeEditable();
}

for (const failure of ["network", "html", "json", "empty-error", "missing-nonce", "invalid-lifetime"]) {
  const phases = ["network", "html", "json"].includes(failure) ? ["initial", "refresh"] : ["initial"];
  for (const phase of phases) {
    test(`${phase} challenge ${failure} failure stays local and recovers`, async ({ page, context, application }) => {
      const state = await mockNetwork(context, application, phase === "initial" ? [failure] : [null, failure]);
      await page.goto(application.baseURL + "/");
      let previousNonce;
      let previousGeneration;
      if (phase === "refresh") {
        previousNonce = await initializedNonce(page);
        previousGeneration = await page.locator(".mock-google-login").getAttribute("data-generation");
        await page.evaluate(() => window.googleLoginTest.current.callback({}));
      }
      const retry = page.getByRole("button", { name: "Retry Google login", exact: true });
      await expect(retry).toBeVisible();
      await expect(retry).toBeEnabled();
      await expect(page.locator(".mock-google-login")).toHaveCount(0);
      const requestsAtFailure = state.challengeRequests;
      await expectMainUsable(page);
      // Router loader revalidation must not issue another login challenge.
      expect(state.challengeRequests).toBe(requestsAtFailure);
      await expect(retry).toBeVisible();
      await retry.click();
      const nonce = await initializedNonce(page);
      expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(state.challengeRequests).toBe(requestsAtFailure + 1);
      if (previousNonce) {
        expect(nonce).not.toBe(previousNonce);
        expect(await page.locator(".mock-google-login").getAttribute("data-generation")).not.toBe(previousGeneration);
      }
      expect(state.pageErrors).toEqual([]);
    });
  }
}

test("callback uses the current nonce and failed verification remounts the button", async ({ page, context, application }) => {
  const state = await mockNetwork(context, application);
  await page.goto(application.baseURL + "/");
  const nonce = await initializedNonce(page);
  const generation = await page.locator(".mock-google-login").getAttribute("data-generation");
  await page.locator(".mock-google-login").click();
  await expect.poll(() => state.callbackNonces).toEqual([nonce]);
  await expect.poll(async () => initializedNonce(page)).not.toBe(nonce);
  expect(await page.locator(".mock-google-login").getAttribute("data-generation")).not.toBe(generation);
  expect(state.pageErrors).toEqual([]);
});

test("tabs keep independent challenges in a shared visitor session", async ({ page, context, application }) => {
  const state = await mockNetwork(context, application);
  await page.goto(application.baseURL + "/");
  const first = await initializedNonce(page);
  const secondTab = await context.newPage();
  await secondTab.goto(application.baseURL + "/");
  const second = await initializedNonce(secondTab);
  expect(second).not.toBe(first);
  expect(await initializedNonce(page)).toBe(first);
  expect(state.challengeRequests).toBe(2);
  expect(state.pageErrors).toEqual([]);
});

test("existing signed-in sessions skip challenges and logout can retry safely", async ({ page, context, application }) => {
  const state = await mockNetwork(context, application, ["network"]);
  const cookie = application.legacySessionCookie({ user: { sub: "browser-logout-fixture", name: "Browser Fixture" } });
  const separator = cookie.indexOf("=");
  await context.addCookies([{
    name: cookie.slice(0, separator), value: cookie.slice(separator + 1),
    url: application.baseURL, httpOnly: true, sameSite: "Lax",
  }]);
  await page.goto(application.baseURL + "/");
  await expect(page.getByText("You are logged in as Browser Fixture", { exact: true })).toBeVisible();
  expect(state.challengeRequests).toBe(0);
  await page.getByRole("button", { name: "Logout", exact: true }).click();
  const retry = page.getByRole("button", { name: "Retry Google login", exact: true });
  await expect(retry).toBeEnabled();
  await expectMainUsable(page);
  await retry.click();
  expect(await initializedNonce(page)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(state.challengeRequests).toBe(2);
  expect(state.pageErrors).toEqual([]);
});

test("real browser offline retries preserve the home screen and recover online", async ({ page, context, application }, testInfo) => {
  const state = await mockNetwork(context, application);
  await page.goto(application.baseURL + "/");
  const initialNonce = await initializedNonce(page);
  const challengeFailed = () => page.waitForEvent("requestfailed", {
    predicate: (request) => new URL(request.url()).pathname === "/api/auth/google/challenge",
  });
  await context.setOffline(true);
  expect(await page.evaluate(() => navigator.onLine)).toBe(false);
  const refreshFailure = challengeFailed();
  await page.evaluate(() => window.googleLoginTest.current.callback({}));
  const failedRefresh = await refreshFailure;
  expect(failedRefresh.failure()?.errorText).toContain("ERR_INTERNET_DISCONNECTED");
  const retry = page.getByRole("button", { name: "Retry Google login", exact: true });
  await expect(retry).toBeEnabled();
  await expect(page.locator(".mock-google-login")).toHaveCount(0);
  await expect(page.locator("#sidebar")).toBeVisible();
  await expect(page.getByRole("searchbox", { name: "Search files" })).toBeEditable();
  const token = page.getByRole("textbox", { name: "Share token", exact: true });
  await token.fill("offline input stays editable");
  await expect(token).toHaveValue("offline input stays editable");
  const retryFailure = challengeFailed();
  await retry.click();
  const failedRetry = await retryFailure;
  expect(failedRetry.failure()?.errorText).toContain("ERR_INTERNET_DISCONNECTED");
  await expect(retry).toBeEnabled();
  await expect(page.locator("#sidebar")).toBeVisible();
  await expect(token).toBeEditable();
  await context.setOffline(false);
  expect(await page.evaluate(() => navigator.onLine)).toBe(true);
  await retry.click();
  expect(await initializedNonce(page)).not.toBe(initialNonce);
  await expectMainUsable(page);
  expect(state.pageErrors).toEqual([]);
  testInfo.annotations.push({
    type: "offline transport",
    description: `context.setOffline(true): refresh=${failedRefresh.failure()?.errorText}; retry=${failedRetry.failure()?.errorText}`,
  });
});
