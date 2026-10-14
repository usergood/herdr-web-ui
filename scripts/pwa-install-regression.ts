import "./test-herdr.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "../server/index.ts";

const state = mkdtempSync(join(tmpdir(), "saurons-pwa-install-"));
const app = createServer({ port: 0, stateDir: state, machines: false, token: "owned-pwa-gate-fixture" });
const authorization = `Basic ${Buffer.from("fixture:fixture-only").toString("base64")}`;
const manifestRequests: { authorized: boolean }[] = [];
const iconRequests: { path: string; authorized: boolean }[] = [];
const proxy = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
  if (new URL(request.url).pathname.startsWith("/icons/")) iconRequests.push({ path: new URL(request.url).pathname, authorized: request.headers.get("authorization") === authorization });
  if (new URL(request.url).pathname === "/manifest.webmanifest") manifestRequests.push({ authorized: request.headers.get("authorization") === authorization });
  if (request.headers.get("authorization") !== authorization) return new Response("Authentication required", { status: 401, headers: { "www-authenticate": 'Basic realm="PWA fixture"' } });
  const url = new URL(request.url);
  const headers = new Headers(request.headers); headers.delete("authorization");
  const response = await fetch(`http://localhost:${app.port}${url.pathname}${url.search}`, { headers, redirect: "manual" });
  const passed = new Headers(response.headers); passed.delete("content-encoding"); passed.delete("content-length");
  // Native URL login supplies install-icon credentials. Keep the fixture app's
  // relative fetch URLs free of userinfo, which Fetch rejects.
  const body = url.pathname === "/" ? (await response.text()).replace("<head>", `<head><base href="http://localhost:${proxy.port}/">`) : response.body;
  return new Response(body, { status: response.status, headers: passed });
} });
const context = await chromium.launchPersistentContext(join(state, "chrome-profile"), { executablePath: process.env["CHROME_PATH"] || chromium.executablePath(), headless: true, args: ["--no-sandbox"], httpCredentials: { username: "fixture", password: "fixture-only" }, viewport: { width: 390, height: 844 } });
try {
  const origin = `http://localhost:${proxy.port}`;
  const page = await context.newPage(); page.setDefaultTimeout(5000);
  const cdp = await context.newCDPSession(page);
  // The installability icon loader needs native browser authentication too;
  // page-scoped Playwright challenge handling misses those requests.
  await page.goto(`http://fixture:fixture-only@localhost:${proxy.port}`, { waitUntil: "load" });
  await page.locator('link[rel="manifest"]').waitFor({ state: "attached" });
  const manifest = await cdp.send("Page.getAppManifest");
  assert(manifest.data && !manifest.errors.some((error) => error.critical), "Chrome can read the manifest behind BasicAuth");
  const parsed = JSON.parse(manifest.data);
  assert.equal(parsed.name, "Saurons eye", "The installed application uses the fork's name");
  assert.equal(parsed.short_name, "Saurons eye");
  assert.equal(parsed.display, "standalone");
  assert(parsed.icons.some((icon: { sizes: string }) => icon.sizes === "192x192"));
  assert(parsed.icons.some((icon: { sizes: string }) => icon.sizes === "512x512"));
  for (const size of [192, 512]) {
    for (const purpose of ["any", "maskable"]) {
      const icon = parsed.icons.find((entry: { sizes: string; purpose: string }) => entry.sizes === `${size}x${size}` && entry.purpose === purpose);
      assert(icon, `${purpose} install icon at ${size}px`);
      const dimensions = await page.evaluate(async (src) => { const image = new Image(); image.src = src; await image.decode(); return { width: image.naturalWidth, height: image.naturalHeight }; }, icon.src);
      assert.deepEqual(dimensions, { width: size, height: size });
    }
  }
  await page.waitForFunction(async () => (await navigator.serviceWorker.getRegistration())?.active?.state === "activated");
  // Chrome's browser-process icon validation can finish after renderer image decoding.
  const iconDeadline = Date.now() + 10_000;
  let installability = await cdp.send("Page.getInstallabilityErrors");
  while (installability.installabilityErrors.length && Date.now() < iconDeadline) {
    await Bun.sleep(100);
    installability = await cdp.send("Page.getInstallabilityErrors");
  }
  assert.deepEqual(installability.installabilityErrors, [], `Chrome reports no installability errors behind BasicAuth; icon requests: ${JSON.stringify(iconRequests)}`);
  assert(manifestRequests.some((request) => request.authorized), "The manifest carries login credentials after its BasicAuth challenge");
  const badge = await page.evaluate(async () => {
    const image = new Image(); image.src = "/icons/badge-96.png?v=eye1"; await image.decode();
    const canvas = document.createElement("canvas"); canvas.width = 96; canvas.height = 96;
    const context = canvas.getContext("2d")!; context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, 96, 96).data; let transparent = 0; let white = 0; let colored = 0;
    for (let index = 0; index < pixels.length; index += 4) { if (pixels[index + 3] === 0) transparent++; else if (pixels[index] === 255 && pixels[index + 1] === 255 && pixels[index + 2] === 255) white++; else colored++; }
    return { width: image.naturalWidth, height: image.naturalHeight, transparent, white, colored };
  });
  assert.equal(badge.width, 96); assert.equal(badge.height, 96); assert(badge.transparent > 0 && badge.white > 0); assert.equal(badge.colored, 0, "Android badge is white on transparent");
  assert.equal((await fetch(`${origin}/api/session`)).status, 401, "Installation support keeps application authentication intact");
  if (process.env["UI_EVIDENCE_DIR"]) { mkdirSync(process.env["UI_EVIDENCE_DIR"], { recursive: true }); await page.locator(".access-gate-mark").waitFor(); await page.screenshot({ path: join(process.env["UI_EVIDENCE_DIR"], "pwa-install-mobile.png") }); }
  console.log("PWA install: credentialed manifest, standalone identity, icons, worker, Android badge and Chrome installability passed");
} finally { await context.close(); proxy.stop(true); app.stop(); rmSync(state, { recursive: true, force: true }); }
