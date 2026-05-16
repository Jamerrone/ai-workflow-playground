import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "test/browser",
  timeout: 60_000,
  retries: 0,
  use: {
    baseURL: "http://localhost:4173",
    headless: true,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "npm run preview:browser",
    url: "http://localhost:4173",
    reuseExistingServer: !process.env["CI"],
    timeout: 30_000,
  },
});
