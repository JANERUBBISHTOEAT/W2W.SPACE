import { readFile, writeFile } from "node:fs/promises";
import { test as base, expect } from "@playwright/test";
import TrackerServer from "bittorrent-tracker/server";
import WebSocket from "ws";
import { startApplication } from "../helpers.mjs";

const test = base.extend({
  application: [async ({ browserName }, use) => {
    expect(browserName).toBe("chromium");
    const application = await startApplication();
    try { await use(application); } finally { await application.stop(); }
  }, { scope: "worker" }],
});

async function startTracker() {
  const server = new TrackerServer({ http: false, udp: false, ws: true, stats: false, interval: 1000 });
  const errors = [];
  server.on("error", (error) => errors.push(error.message));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    url: `ws://127.0.0.1:${server.http.address().port}`,
    errors,
    stop: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Relay real tracker signaling locally; the browser still sends file bytes over native WebRTC. */
async function localPeerContext(browser, application, tracker, { paused = false } = {}) {
  const context = await browser.newContext({ acceptDownloads: true });
  const sockets = new Set();
  const pending = [];
  const pageErrors = [];
  let released = !paused;
  const release = () => {
    released = true;
    pending.splice(0).forEach((send) => send());
  };
  context.on("page", (page) => page.on("pageerror", (error) => pageErrors.push(error.message)));
  const origin = new URL(application.baseURL).origin;
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin === origin || ["blob:", "data:"].includes(url.protocol)) return route.continue();
    return route.abort();
  });
  // Local peers need no public STUN/TURN service. This changes only ICE server
  // configuration; connection setup, torrent hashing and data channels are real.
  await context.addInitScript(() => {
    const NativeConnection = window.RTCPeerConnection;
    const connections = [];
    window.w2wTestPeerDiagnostics = () => connections.map((connection) => ({
      state: connection.connectionState,
      ice: connection.iceConnectionState,
      localCandidates: (connection.localDescription?.sdp.match(/^a=candidate:/gm) || []).length,
      remoteCandidates: (connection.remoteDescription?.sdp.match(/^a=candidate:/gm) || []).length,
    }));
    window.RTCPeerConnection = class extends NativeConnection {
      constructor(configuration, ...rest) {
        super({ ...configuration, iceServers: [] }, ...rest);
        connections.push(this);
      }
    };
  });
  await context.routeWebSocket(/^wss?:\/\//, (route) => {
    // A peer can announce to several public trackers. Relay one shared tracker
    // only, so one server does not see duplicate sockets for the same peer ID.
    tracker.publicURL ??= route.url();
    if (route.url() !== tracker.publicURL) {
      void route.close().catch(() => {});
      return;
    }
    const socket = new WebSocket(tracker.url);
    sockets.add(socket);
    const waiting = [];
    let closed = false;
    const forward = (message) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(message);
      else if (socket.readyState === WebSocket.CONNECTING) waiting.push(message);
    };
    socket.on("open", () => waiting.splice(0).forEach((message) => socket.send(message)));
    socket.on("message", (message) => { if (!closed) route.send(message.toString()); });
    socket.on("error", () => { void route.close().catch(() => {}); });
    socket.on("close", () => { sockets.delete(socket); void route.close().catch(() => {}); });
    route.onMessage((message) => {
      if (released) forward(message);
      else pending.push(() => forward(message));
    });
    route.onClose(() => { closed = true; socket.close(); });
  });
  return {
    context, release, pageErrors,
    async stop() {
      await context.close();
      for (const socket of sockets) socket.terminate();
    },
  };
}

async function expectReloadConfirmation(page) {
  // Chromium requires a real user gesture before displaying beforeunload.
  await page.locator('.transfer-status-label [role="status"]').click();
  const previousURL = page.url();
  const dialogPromise = page.waitForEvent("dialog", { timeout: 10000 });
  const reload = page.reload({ timeout: 10000 }).catch(() => null);
  const dialog = await dialogPromise;
  expect(dialog.type()).toBe("beforeunload");
  await dialog.dismiss();
  await reload;
  expect(page.url()).toBe(previousURL);
  await expect(page.locator(".transfer-status-label")).toBeVisible();
}

test("a variable-length token starts a real download and transfers survive page navigation", async ({ browser, application }, testInfo) => {
  test.setTimeout(120000);
  const tracker = await startTracker();
  const sender = await localPeerContext(browser, application, tracker);
  const receiver = await localPeerContext(browser, application, tracker, { paused: true });
  let releaseLookup;
  try {
    const seedPage = await sender.context.newPage();
    await seedPage.goto(application.baseURL + "/new");
    await seedPage.getByRole("button", { name: /New File/ }).click();
    await expect(seedPage.locator("#fileInput")).toBeAttached();
    await expect(seedPage.getByRole("textbox", { name: "Token", exact: true })).toHaveValue("");

    const bytes = Buffer.alloc(512 * 1024);
    for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
    const published = seedPage.waitForResponse((response) =>
      /\/api\/[^/]+\/token/.test(new URL(response.url()).pathname)
      && response.request().method() === "POST"
      && response.request().postData()?.includes("acquireToken"));
    await seedPage.locator("#fileInput").setInputFiles({
      name: "w2w-browser-transfer.bin", mimeType: "application/octet-stream", buffer: bytes,
    });
    const response = await published;
    expect(response.status()).toBe(200);
    const share = await response.json();
    expect(share.token).toMatch(/^\d{1,6}$/);
    await expect(seedPage.locator(".transfer-status")).toContainText("Seeding");
    await expect(seedPage).toHaveURL(/\/files\/[^/]+\/?(?:\?.*)?$/);
    await seedPage.getByRole("link", { name: "Home", exact: true }).click();
    await expect(seedPage.locator(".transfer-status")).toContainText("Seeding");

    const receivePage = await receiver.context.newPage();
    const requests = [];
    receivePage.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/new/token" && request.method() === "POST") {
        requests.push(request.postData());
      }
    });
    await receivePage.goto(application.baseURL + "/");
    const lookupGate = new Promise((resolve) => { releaseLookup = resolve; });
    let markLookupReady;
    const lookupReady = new Promise((resolve) => { markLookupReady = resolve; });
    await receivePage.route("**/api/new/token", async (route) => {
      const response = await route.fetch();
      markLookupReady();
      await lookupGate;
      await route.fulfill({ response });
    });
    const input = receivePage.getByRole("textbox", { name: "Share token", exact: true });
    await input.fill("12345");
    // Typed tokens shorter than six digits wait for Enter, even if this prefix
    // already identifies a valid share. Six-digit typing still uses 600 ms.
    await receivePage.waitForTimeout(900);
    expect(requests).toEqual([]);
    const downloadPromise = receivePage.waitForEvent("download", { timeout: 60000 });
    // A prior assertion can close the context before this promise is awaited.
    // Handle rejection immediately so teardown cannot hide the original error.
    void downloadPromise.catch(() => {});
    await input.fill(share.token);
    if (share.token.length < 6) await input.press("Enter");
    await expect.poll(() => requests.length).toBe(1);
    await lookupReady;
    // An accepted download intent survives navigation even while its real
    // server response is still in flight.
    await receivePage.getByRole("button", { name: "New", exact: true }).click();
    await expect(receivePage).toHaveURL(/\/new$/);
    releaseLookup();
    await expect(receivePage.locator(".transfer-status")).toContainText("Downloading");
    for (const [name, page] of [["seeding-status-desktop", seedPage], ["downloading-status-desktop", receivePage]]) {
      const path = testInfo.outputPath(`${name}.png`);
      await page.screenshot({ path, animations: "disabled" });
      await testInfo.attach(name, { path, contentType: "image/png" });
    }
    const desktopViewport = seedPage.viewportSize();
    await seedPage.setViewportSize({ width: 390, height: 844 });
    // The wrapper has no width: its visible children are fixed to the viewport.
    await expect(seedPage.locator(".transfer-status-label")).toBeVisible();
    const mobileScreenshot = testInfo.outputPath("seeding-status-mobile.png");
    await seedPage.screenshot({ path: mobileScreenshot, animations: "disabled" });
    await testInfo.attach("seeding-status-mobile", {
      path: mobileScreenshot, contentType: "image/png",
    });
    if (desktopViewport) await seedPage.setViewportSize(desktopViewport);
    receiver.release();

    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("w2w-browser-transfer.bin");
    expect(await download.failure()).toBeNull();
    expect(await readFile(await download.path())).toEqual(bytes);
    await expect(receivePage.locator(".transfer-status")).toContainText("Seeding");
    expect(requests).toHaveLength(1);
    // Finished downloads also seed; closing either participant interrupts work.
    await expectReloadConfirmation(seedPage);
    await expectReloadConfirmation(receivePage);
    expect(sender.pageErrors).toEqual([]);
    expect(receiver.pageErrors).toEqual([]);
    expect(tracker.errors).toEqual([]);
    const evidencePath = testInfo.outputPath("real-webrtc-transfer.json");
    await writeFile(evidencePath, JSON.stringify({ bytes: bytes.length, peers: 2, signaling: "local WebSocket tracker", transport: "native WebRTC data channel", contentMatches: true }));
    await testInfo.attach("real-webrtc-transfer", { path: evidencePath, contentType: "application/json" });
  } finally {
    releaseLookup?.();
    const peers = await Promise.all([sender, receiver].map(async (peer) => ({
      errors: peer.pageErrors,
      pages: await Promise.all(peer.context.pages().map((page) =>
        page.evaluate(() => window.w2wTestPeerDiagnostics?.()).catch(() => null))),
    })));
    const diagnosticsPath = testInfo.outputPath("peer-diagnostics.json");
    await writeFile(diagnosticsPath, JSON.stringify({ peers, trackerErrors: tracker.errors }));
    await testInfo.attach("peer-diagnostics", { path: diagnosticsPath, contentType: "application/json" });
    await receiver.stop();
    await sender.stop();
    await tracker.stop();
  }
});

test("editing a token discards an earlier successful lookup", async ({ page, application }) => {
  const publication = await fetch(application.baseURL + "/api/new/token", {
    method: "POST",
    body: new URLSearchParams({
      intent: "acquireToken", filename: "stale-lookup.txt", filesize: "21",
      magnet: "magnet:?xt=urn:btih:8a06bb813af346d8732e6b50fb46b2f687163784&dn=stale-lookup.txt",
    }),
  });
  expect(publication.status).toBe(200);
  const { token } = await publication.json();
  let release;
  let markReady;
  let markReleased;
  const gate = new Promise((resolve) => { release = resolve; });
  const ready = new Promise((resolve) => { markReady = resolve; });
  const released = new Promise((resolve) => { markReleased = resolve; });
  await page.route("**/api/new/token", async (route) => {
    const response = await route.fetch();
    markReady();
    await gate;
    // Clearing the field aborts the browser request; a late response may
    // already have arrived at the server and must still be ignored locally.
    try { await route.fulfill({ response }); } catch { /* Browser cancelled it. */ }
    finally { markReleased(); }
  });
  try {
    await page.goto(application.baseURL + "/");
    const input = page.getByRole("textbox", { name: "Share token", exact: true });
    await input.fill(token);
    if (token.length < 6) await input.press("Enter");
    await ready;
    await input.fill("");
    release();
    await released;
    await page.waitForTimeout(700);
    await expect(page.locator(".transfer-status")).toHaveCount(0);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("w2w.files.v1") || "[]"))).toEqual([]);
    await expect(page.locator("#token-input-hint")).toHaveCount(0);
  } finally { release(); }
});

test("short typing waits for Enter, pasting starts immediately, and six digits start automatically", async ({ page, context, application }) => {
  const requests = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/new/token" && request.method() === "POST") requests.push(request.postData());
  });
  // Find unused aliases without assuming which short tokens other tests own.
  const findMissingToken = async (length) => {
    for (let candidate = 0; candidate < 10; candidate++) {
      const token = String(candidate).padStart(length, "0");
      const response = await fetch(application.baseURL + "/api/new/token", {
        method: "POST", body: new URLSearchParams({ intent: "acquireMagnet", token }),
      });
      expect(response.ok).toBe(true);
      if (!(await response.json()).type) return token;
    }
    throw new Error(`No unused ${length}-digit token available`);
  };
  const shortToken = await findMissingToken(1);
  const sixDigitToken = await findMissingToken(6);
  await page.goto(application.baseURL + "/");
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: application.baseURL });
  const input = page.getByRole("textbox", { name: "Share token", exact: true });
  for (const typed of ["1", "12", "123", "1234", "12345"]) {
    await input.fill(typed);
    await page.clock.runFor(700);
    expect(requests).toHaveLength(0);
  }
  await input.fill(shortToken);
  await input.press("Enter");
  await expect.poll(() => requests.length).toBe(1);
  await expect(page.locator("#token-input-hint")).toContainText("No share found");
  await input.press("Enter");
  await expect.poll(() => requests.length).toBe(2);
  await expect(page.locator("#token-input-hint")).toContainText("No share found");

  await input.fill("");
  await page.evaluate((token) => navigator.clipboard.writeText(token), shortToken);
  await input.click();
  await input.press("Control+V");
  // The page clock remains paused: paste must issue its request immediately,
  // without waiting for the typing debounce to advance.
  await expect.poll(() => requests.length).toBe(3);
  await expect(page.locator("#token-input-hint")).toContainText("No share found");

  await input.fill(sixDigitToken);
  await page.clock.runFor(599);
  expect(requests).toHaveLength(3);
  await page.clock.runFor(1);
  await expect.poll(() => requests.length).toBe(4);
  await expect(page.locator("#token-input-hint")).toContainText("No share found");
  await expect(page.locator(".transfer-status")).toHaveCount(0);
});

test("token guidance appears on hover without moving the input and closes with Escape", async ({ page, application }, testInfo) => {
  await page.goto(application.baseURL + "/");
  const input = page.getByRole("textbox", { name: "Share token", exact: true });
  const tooltip = page.getByRole("tooltip");
  const guidance = "Paste to receive, or press Enter after typing.";
  await expect(input).toBeVisible();
  expect(await input.getAttribute("title")).toBeNull();
  await expect(page.getByText("Receive using your token:", { exact: true })).toHaveCount(0);
  await expect(page.locator("#token-input-hint")).toHaveCount(0);
  await expect(tooltip).toHaveCount(0);
  const originalBox = await input.boundingBox();
  expect(originalBox).not.toBeNull();
  await input.hover();
  await expect(tooltip).toHaveText(guidance);
  await expect(tooltip).toBeVisible();
  expect(await input.boundingBox()).toEqual(originalBox);
  const screenshot = testInfo.outputPath("token-tooltip-desktop.png");
  await page.screenshot({ path: screenshot, animations: "disabled" });
  await testInfo.attach("token-tooltip-desktop", { path: screenshot, contentType: "image/png" });
  await page.keyboard.press("Escape");
  await expect(tooltip).toHaveCount(0);
  expect(await input.boundingBox()).toEqual(originalBox);

  await page.mouse.move(0, 0);
  await input.focus();
  await expect(tooltip).toHaveText(guidance);
  await page.keyboard.press("Escape");
  await expect(tooltip).toHaveCount(0);
  await expect(input).toHaveValue("");
});

test("an idle browser reloads without an interruption prompt", async ({ page, application }) => {
  const dialogs = [];
  page.on("dialog", async (dialog) => { dialogs.push(dialog.type()); await dialog.dismiss(); });
  await page.route("**/*", (route) => new URL(route.request().url()).origin === new URL(application.baseURL).origin
    ? route.continue() : route.abort());
  await page.goto(application.baseURL + "/");
  await page.getByRole("textbox", { name: "Share token", exact: true }).click();
  await expect(page.locator(".transfer-status")).toHaveCount(0);
  await page.reload();
  await expect(page.locator("#sidebar")).toBeVisible();
  expect(dialogs).toEqual([]);
});
