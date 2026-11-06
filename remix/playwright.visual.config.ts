import { defineConfig } from "@playwright/test";
import { tmpdir } from "node:os";
import { join } from "node:path";

const output = process.env.W2W_VISUAL_OUTPUT_DIR || join(tmpdir(), "w2w-visual-results");

export default defineConfig({
  testDir: "./tests/visual",
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  timeout: 60000,
  expect: { timeout: 10000 },
  outputDir: join(output, "test-results"),
  snapshotPathTemplate: join(output, "baseline", "{testFilePath}", "{arg}{ext}"),
  reporter: process.env.CI ? "github" : "list",
  use: {
    browserName: "chromium",
    headless: true,
    deviceScaleFactor: 1,
    locale: "en-US",
    timezoneId: "UTC",
    reducedMotion: "reduce",
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined },
    trace: "retain-on-failure",
  },
});
