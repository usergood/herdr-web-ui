import "./test-herdr.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "../server/index.ts";

const state = mkdtempSync(join(tmpdir(), "saurons-notification-icons-"));
const app = createServer({ port: 0, stateDir: state, machines: false, token: "owned-pwa-gate-fixture" });
const authorization = `Basic ${Buffer.from("fixture:fixture-only").toString("base64")}`;
let blockNotificationImages = false;
const proxy = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
  if (blockNotificationImages && new URL(request.url).pathname.startsWith("/icons/")) return new Response("Background image request blocked", { status: 403 });
  if (request.headers.get("authorization") !== authorization) return new Response("Authentication required", { status: 401, headers: { "www-authenticate": 'Basic realm="PWA fixture"' } });
  const url = new URL(request.url);
  const headers = new Headers(request.headers); headers.delete("authorization");
  const response = await fetch(`http://localhost:${app.port}${url.pathname}${url.search}`, { headers, redirect: "manual" });
  const passed = new Headers(response.headers); passed.delete("content-encoding"); passed.delete("content-length");
  return new Response(response.body, { status: response.status, headers: passed });
} });
const context = await chromium.launchPersistentContext(join(state, "chrome-profile"), { executablePath: process.env["CHROME_PATH"] || chromium.executablePath(), headless: true, args: ["--no-sandbox"], httpCredentials: { username: "fixture", password: "fixture-only" }, viewport: { width: 390, height: 844 } });
try {
  const origin = `http://localhost:${proxy.port}`;
  const page = await context.newPage(); page.setDefaultTimeout(10000);
  const cdp = await context.newCDPSession(page);
  await page.goto(origin, { waitUntil: "load" });
  await page.waitForFunction(async () => (await navigator.serviceWorker.getRegistration())?.active?.state === "activated");
  await context.grantPermissions(["notifications"], { origin });
  const worker = context.serviceWorkers()[0]!;
  await worker.evaluate(() => {
    const captured: { icon: string; badge: string }[] = [];
    Object.assign(globalThis, { ownedNotificationImages: captured });
    self.registration.showNotification = async (_title, options) => { captured.push({ icon: options!.icon!, badge: options!.badge! }); };
  });
  let registrationId = "";
  cdp.on("ServiceWorker.workerRegistrationUpdated", event => {
    const registration = event.registrations.find((entry: { scopeURL: string; isDeleted: boolean }) => entry.scopeURL === origin + "/" && !entry.isDeleted);
    if (registration) registrationId = registration.registrationId;
  });
  await cdp.send("ServiceWorker.enable");
  const registrationDeadline = Date.now() + 10000;
  while (!registrationId) { if (Date.now() > registrationDeadline) throw new Error("Owned notification worker was not registered"); await Bun.sleep(50); }
  await page.evaluate(async () => {
    for (const name of await caches.keys()) { const cache = await caches.open(name); for (const request of await cache.keys()) if (new URL(request.url).pathname.startsWith("/icons/")) await cache.delete(request); }
  });
  await cdp.send("Network.enable"); await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  blockNotificationImages = true;
  await cdp.send("ServiceWorker.deliverPushMessage", { origin, registrationId, data: JSON.stringify({ title: "Owned notification icon fixture", body: "No live device is targeted", tag: "owned-icon-fixture" }) });
  const notificationDeadline = Date.now() + 10000;
  let notification: { icon: string; badge: string } | undefined;
  while (!notification) { notification = await worker.evaluate(() => (globalThis as any).ownedNotificationImages[0]); if (notification) break; if (Date.now() > notificationDeadline) throw new Error("Owned push did not reach the notification API"); await Bun.sleep(50); }
  const notificationImages = await page.evaluate(async notification => {
    const dimensions = async (src: string) => { const image = new Image(); image.src = src; await image.decode(); return { width: image.naturalWidth, height: image.naturalHeight }; };
    return { icon: await dimensions(notification.icon), badge: await dimensions(notification.badge) };
  }, notification);
  assert.deepEqual(notificationImages, { icon: { width: 192, height: 192 }, badge: { width: 96, height: 96 } }, "Notification images remain readable when background icon URLs are blocked");
  console.log("Notification icons: bundled Eye and Android badge decode while background icon requests are blocked; no live device was targeted");
} finally { await context.close(); proxy.stop(true); app.stop(); rmSync(state, { recursive: true, force: true }); }
