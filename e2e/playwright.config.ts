import { execSync } from "node:child_process";
import { defineConfig } from "@playwright/test";

/** The server needs node:sqlite (>=22.5). Some local toolchains (pnpm
 *  shims under Volta) spawn an older node; route through `volta run`
 *  there so the project's pin applies. CI's node is new enough as-is. */
function nodeCmd(): string {
  if (Number(process.versions.node.split(".")[0]) >= 22) return "node";
  try {
    execSync("volta --version", { stdio: "ignore" });
    return "volta run node";
  } catch {
    return "node";
  }
}

// The suite runs against the real single-process deployment: the bundled
// sync server serving the built web app, with a throwaway data dir.
export default defineConfig({
  testDir: "./tests",
  timeout: 30_000,
  workers: 1, // one shared server; boards are namespaced per test
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "line" : "list",
  use: {
    baseURL: "http://localhost:8901",
    viewport: { width: 1280, height: 800 },
  },
  webServer: {
    command: `rm -rf .data && ${nodeCmd()} ../apps/sync/dist/server.mjs`,
    port: 8901,
    reuseExistingServer: false,
    env: {
      PORT: "8901",
      ORIM_DATA_DIR: ".data",
      ORIM_WEB_DIST: "../apps/web/dist",
      ORIM_PUBLIC_URL: "http://localhost:8901",
    },
  },
});
