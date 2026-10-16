/** The fork's real page and API cannot enable upstream reporting. Run after `bun run build`. */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import { createServer } from "../server/index.ts";
import { UsageService } from "../server/usage.ts";
import { openSettingsPage } from "./settings-page.ts";
import { chromePath } from "./chrome-path.ts";

/** Retain the upstream helper's place in the UI suite while proving the fork's no-reporting policy. */
export async function checkTelemetrySettings(browser: Browser): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "herdr-privacy-browser-"));
  const state = join(root, "server-state");
  const server = createServer({
    port: 0, hostname: "127.0.0.1", token: "", stateDir: state,
    accountDiscoveryHome: join(root, "account-home"), native: { version: async () => null },
    usage: new UsageService(undefined, []), registerBridge: false,
  });
  try {
    await server.statusReady;
    const origin = `http://127.0.0.1:${server.port}`;
    for (const method of ["GET", "POST"]) {
      const response = await fetch(`${origin}/api/telemetry`, {
        method, headers: { origin, "x-herdr-update": "1", "content-type": "application/json" },
        ...(method === "POST" ? { body: JSON.stringify({ enabled: true, notice_seen: true }) } : {}),
      });
      assert.equal(response.status, 404, `${method} cannot expose or enable removed reporting`);
      assert.equal((await response.json()).error.code, "not_found");
    }
    for (const mobile of [false, true]) {
      const context = await browser.newContext({
        viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 },
        isMobile: mobile, hasTouch: mobile, locale: "en-US",
      });
      try {
        const external: string[] = [];
        const reporting: string[] = [];
        const errors: string[] = [];
        // No fixture request can reach an upstream service, including a regression's sender.
        await context.route("**/*", async (route) => {
          const url = new URL(route.request().url());
          if (["http:", "https:"].includes(url.protocol) && url.origin !== origin) {
            external.push(url.href);
            await route.abort();
          } else await route.continue();
        });
        await context.addInitScript(() => localStorage.setItem("herdr-web-ui:settings", JSON.stringify({
          language: "en", palette: "catppuccin", defaultView: "chat", alertsOn: false,
          quickReplies: ["Owned private reply canary"], terminalFontFamily: "Owned private font canary",
        })));
        const page = await context.newPage();
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("request", (request) => {
          if (new URL(request.url()).pathname === "/api/telemetry") reporting.push(request.method());
        });
        await page.goto(origin);
        await page.locator(".conn-live").waitFor();
        await page.keyboard.press("ControlOrMeta+Shift+Comma");
        await openSettingsPage(page, "Appearance");
        await page.locator("#settings-palette").selectOption("forest");
        await page.waitForFunction(() => JSON.parse(localStorage.getItem("herdr-web-ui:settings") ?? "{}").palette === "forest");
        await openSettingsPage(page, "About");
        assert.equal(await page.locator(".settings-telemetry").count(), 0, "About has no reporting controls or preview");
        assert.equal(await page.getByRole("switch", { name: "Send anonymous usage counts", exact: true }).count(), 0);
        assert.equal(await page.getByText("herdr web ui sends anonymous usage counts", { exact: false }).count(), 0);
        await page.getByRole("button", { name: "Close settings", exact: true }).click();
        await page.reload();
        await page.locator(".conn-live").waitFor();
        assert.deepEqual(reporting, [], "initial load, settings changes and reload make no telemetry requests");
        assert.deepEqual(external, [], "private settings stay off upstream services");
        assert.deepEqual(errors, []);
      } finally { await context.close(); }
    }
    assert.equal(existsSync(join(state, "telemetry.json")), false, "the server creates no telemetry identity");
    console.log("PASS fork privacy: reporting GET/POST refused, desktop/mobile settings and reload send no telemetry or upstream requests, no reporting controls or identity");
  } finally {
    server.stop();
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox", "--accept-lang=en-US"] });
  try { await checkTelemetrySettings(browser); }
  finally { await browser.close(); }
}
