import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  outputDir: "../../test-results/report-browser",
  timeout: 30_000,
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    browserName: "chromium",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "off"
  }
});
