/** Capture the real fork UI with owned fixtures. Run through `check run --build`; see the gallery. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser, type Locator, type Page } from "playwright-core";
import { createServer } from "../server/index.ts";
import type { FactoryDetail, FactoryProject, Implementation, ProjectReferenceLibrary, SpecificationVersion } from "../shared/protocol.ts";
import { disposableConfig } from "./disposable-config.ts";

const fixtureSocket = join(process.env["XDG_CONFIG_HOME"] ?? "", "herdr", "sessions", process.env["HERDR_TEST_SESSION"] ?? "herdr-web-ui-test", "herdr.sock");
assert(process.env["HERDR_TEST_LIVE"] !== "1" && disposableConfig(process.env, fixtureSocket), "Use bun run check run --build bun scripts/fork-feature-media.ts <output-directory>");
await import("./test-herdr.ts");
assert(disposableConfig(process.env, process.env["HERDR_SOCKET"] ?? ""), "The fixture herdr must use the check runner's private config");

const out = resolve(process.argv[2] ?? join(tmpdir(), "saurons-eye-feature-media"));
const owned = mkdtempSync(join(tmpdir(), "saurons-eye-media-fixtures-"));
let app: ReturnType<typeof createServer> | undefined;
let browser: Browser | undefined;
const screenshots: { file: string; feature: string; viewport: { width: number; height: number }; touch: boolean }[] = [];
const errors: string[] = [];
const network: string[] = [];
const views = [
  { name: "desktop", viewport: { width: 1600, height: 1000 }, touch: false },
  { name: "mobile", viewport: { width: 390, height: 844 }, touch: true },
];

async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`http://localhost:${app!.port}/api/factory${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", "x-herdr-factory": "1" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000),
  });
  assert(response.ok, `${path}: ${response.status} ${response.ok ? "" : await response.text()}`);
  return response.json() as Promise<T>;
}

function section(page: Page, name: string): Locator {
  return page.locator(".factory-section").filter({ has: page.getByRole("heading", { name, exact: true }) }).last();
}

async function capture(feature: string, hash: string, prepare: (page: Page) => Promise<Locator | null>): Promise<void> {
  for (const view of views) {
    const context = await browser!.newContext({ viewport: view.viewport, isMobile: view.touch, hasTouch: view.touch, deviceScaleFactor: 1, locale: "en-US", timezoneId: "UTC", colorScheme: "dark", reducedMotion: "reduce" });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(10_000);
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("request", (request) => { if (/^https?:/.test(request.url()) && new URL(request.url()).hostname !== "localhost") network.push(request.url()); });
      await page.goto(`http://localhost:${app!.port}/`);
      await page.locator(".conn-live").waitFor({ state: "attached" });
      if (!view.touch) await page.locator(".sidebar-toggle").click();
      await page.goto(`http://localhost:${app!.port}/${hash}`);
      await page.locator(".factory-panel").first().waitFor();
      const anchor = await prepare(page);
      if (anchor) await anchor.evaluate((element) => element.scrollIntoView({ block: "start", inline: "nearest" }));
      else await page.locator(".factory-panel").evaluate((element) => { element.scrollTop = 0; });
      await page.evaluate(async () => { await document.fonts.ready; });
      await page.getByRole("status").filter({ hasText: /^Saving…$/ }).waitFor({ state: "hidden" });
      const alerts = await page.getByRole("alert").allTextContents();
      if (alerts.length) await page.screenshot({ path: join(out, `${feature}-${view.name}-failure.png`) });
      assert.deepEqual(alerts, [], `${feature}: no application error`);
      const file = `${feature}-${view.name}.png`;
      await page.screenshot({ path: join(out, file), animations: "disabled", fullPage: false });
      screenshots.push({ file, feature, viewport: view.viewport, touch: view.touch });
      console.log(`Captured ${file}`);
    } finally { await context.close(); }
  }
}

try {
  mkdirSync(out, { recursive: true });
  const repo = join(owned, "demo-storefront");
  mkdirSync(repo);
  execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
  writeFileSync(join(repo, "refund.ts"), 'export function refund(requestId: string) {\n  return { requestId, status: "created" };\n}\n');
  writeFileSync(join(repo, "README.md"), "# Fictional storefront\n\nOwned screenshot fixture; no customer data.\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["-c", "user.name=Media fixture", "-c", "user.email=media@example.test", "commit", "-m", "Fictional storefront"], { cwd: repo, stdio: "ignore" });
  app = createServer({ port: 0, stateDir: join(owned, "app"), token: "" });
  browser = await chromium.launch({ executablePath: process.env["CHROME_PATH"] || chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
  const project = await api<FactoryProject>("/projects", { name: "Demo storefront", path: repo, provider: "codex", machine_id: "local", tracker: "app" });
  const idea = await api<Implementation>("/implementations", { title: "Make refunds safe to retry", description: "A fictional storefront needs repeatable refunds and clear evidence before release." });
  const prefix = `/implementations/${idea.id}`;
  await api(`${prefix}/configure`, { project_id: project.id });
  for (const title of ["Improve the mobile receipt", "Document deployment recovery", "Add a weekly usage report"]) await api("/implementations", { title, description: "Fictional example captured in the durable Inbox." });
  const detail = await api<FactoryDetail>(prefix);
  await api(`${prefix}/messages`, { chat_id: detail.chats[0]!.id, role: "owner", content: "## Decision notes\n\n- Keep the existing refund identifier stable.\n- Save check and review evidence with the Implementation.\n- Deployment remains an explicit owner action." });
  const preview = '<!doctype html><html><body><h1>Refund receipt</h1><p>Fictional order: DEMO-1042</p><p><strong>Status: refunded</strong></p><ul><li>Same request, same refund</li><li>Clear customer receipt</li><li>Retained evidence</li></ul></body></html>';
  await api(`${prefix}/artifacts`, { chat_id: detail.chats[0]!.id, name: "refund-receipt.html", media_type: "text/html", content_base64: Buffer.from(preview).toString("base64"), size: Buffer.byteLength(preview), origin: "upload" });
  let library = await api<ProjectReferenceLibrary>(`/projects/${project.id}/references`);
  await api(`/projects/${project.id}/references`, { expected_revision: library.revision, name: "refund-policy.md", title: "Refund policy", media_type: "text/markdown", content_base64: Buffer.from("# Refund policy\n\nKeep refunds idempotent. Preserve the original request identifier and check retry behavior before release.\n\n## Evidence\n\nRetain the test report and captured review findings.").toString("base64"), usage_note: "Read before changing refund behavior or its tests.", read_policy: "always", caption: "" });
  library = await api<ProjectReferenceLibrary>(`/projects/${project.id}/references`);
  await api(`/projects/${project.id}/references`, { expected_revision: library.revision, name: "eye-mark.png", title: "App icon reference", media_type: "image/png", content_base64: readFileSync(join(import.meta.dir, "../public/icons/icon-192.png")).toString("base64"), usage_note: "Use when reviewing the installed app identity.", read_policy: "reference", caption: "Bundled Saurons eye artwork, retained outside the repository." });
  const spec = await api<SpecificationVersion>(`${prefix}/specifications`, { content: "## Safe refund retries\n\nRepeated requests return the original refund. Keep the existing receipt readable on a phone.\n\n### Acceptance\n\n- Retrying creates no duplicate refund.\n- API and browser checks pass.\n- Review findings retain their file and line anchors." });
  await api(`${prefix}/approvals`, { kind: "specification", revision: spec.id, scope: "Accept this fictional screenshot specification" });
  await api(`${prefix}/approvals`, { kind: "testing_seams", revision: spec.id, scope: "Public refund API with owned fixtures and real browser user journeys" });
  await api(`${prefix}/tickets`, { specification_id: spec.id, tickets: [
    { key: "api", title: "Preserve the refund request identifier", acceptance: "Repeated API requests return one refund.", dependencies: [] },
    { key: "receipt", title: "Show a clear mobile receipt", acceptance: "The receipt fits the phone viewport.", dependencies: ["api"] },
    { key: "checks", title: "Retain checks and review evidence", acceptance: "Save current API/browser checks and anchored findings.", dependencies: ["api", "receipt"] },
  ] });
  const planned = await api<FactoryDetail>(prefix);
  await api(`${prefix}/approvals`, { kind: "ticket_graph", revision: planned.graph_hash, scope: "Accept this fictional dependency graph" });
  const drafting = await api<Implementation>("/implementations", { title: "Prepare a customer export", description: "Fictional specification awaiting owner review." });
  await api(`/implementations/${drafting.id}/specifications`, { content: "## Export customer receipts\n\nKeep the export format versioned and review it before execution." });

  const hash = `#factory/${idea.id}`;
  await capture("inbox", "#factory", async (page) => { await page.getByRole("button", { name: "Improve the mobile receipt", exact: true }).waitFor(); return null; });
  await capture("notes", hash, async (page) => { await page.getByRole("heading", { name: "Decision notes", exact: true }).waitFor(); return section(page, "Notes"); });
  await capture("attachments", hash, async (page) => { await page.frameLocator('iframe[title="refund-receipt.html"]').getByRole("heading", { name: "Refund receipt", exact: true }).waitFor(); return section(page, "Attachments"); });
  await capture("references", `#projects/${project.id}/settings`, async (page) => {
    await page.getByRole("tab", { name: "Project references", exact: true }).click();
    const references = page.getByRole("region", { name: "Project references", exact: true });
    await references.getByRole("heading", { name: "Refund policy · v1", exact: true }).waitFor();
    await references.getByRole("article").filter({ has: page.getByRole("heading", { name: "App icon reference · v1", exact: true }) }).getByRole("button", { name: "Read reference", exact: true }).click();
    await references.getByRole("img", { name: "eye-mark.png", exact: true }).evaluate((image) => (image as HTMLImageElement).decode());
    return references;
  });
  await capture("specification", hash, async (page) => { assert(await page.getByRole("button", { name: "Accept specification", exact: true }).isDisabled()); return section(page, "Specification"); });
  await capture("tickets", hash, async (page) => { await page.getByText("Retain checks and review evidence", { exact: true }).waitFor(); return section(page, "Tickets"); });

  // Only the owned repository changes; capture and findings use the application's actual review API.
  writeFileSync(join(repo, "refund.ts"), 'export function refund(requestId: string) {\n  return { requestId, status: "refunded", retrySafe: true };\n}\n');
  await capture("review", hash, async (page) => {
    const review = section(page, "Review changes");
    await review.getByRole("button", { name: "Capture review", exact: true }).click();
    await review.getByRole("heading", { name: "refund.ts · unstaged:M", exact: true }).waitFor();
    await review.getByRole("spinbutton", { name: "Line", exact: true }).fill("2");
    await review.getByRole("textbox", { name: "Review finding", exact: true }).fill("Add a retry check that proves the original refund identifier is retained.");
    await review.getByRole("button", { name: "Save draft finding", exact: true }).click();
    await review.getByText("Add a retry check that proves the original refund identifier is retained.", { exact: true }).first().waitFor();
    assert(await review.getByRole("button", { name: "Request changes", exact: true }).isDisabled(), "No native Run is invented for the screenshot");
    return review;
  });
  await capture("recovery", "#projects", async (page) => {
    await page.getByRole("tab", { name: "Factory", exact: true }).click();
    const recovery = page.locator("details").filter({ has: page.locator("summary").filter({ hasText: /^Factory settings and recovery$/ }) }).first();
    await recovery.locator("summary").click();
    await recovery.getByRole("button", { name: "Create verified backup", exact: true }).click();
    await recovery.getByRole("button", { name: "Restore to an isolated copy", exact: true }).last().click();
    await recovery.getByRole("status").filter({ hasText: "Restored copy: execution remains disabled." }).waitFor();
    return recovery;
  });

  assert.deepEqual(errors, [], "No browser exceptions");
  assert.deepEqual(network, [], "No external browser requests");
  const retained = await api<FactoryDetail>(prefix);
  assert.equal(retained.artifacts.length, 1);
  assert.equal(retained.tickets.length, 3);
  assert.equal(retained.runs.length, 0);
  assert(retained.comments.length >= 2);
  writeFileSync(join(out, "capture.json"), JSON.stringify({ source_commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: join(import.meta.dir, ".."), encoding: "utf8" }).trim(), captured_at: new Date().toISOString(), data: "Fictional fixtures through the real HTTP API and browser client", native_execution: false, browser: browser.version(), screenshots }, null, 2) + "\n");
  console.log(`Fork feature walkthrough passed: ${screenshots.length} screenshots, retained records and isolated recovery, no native Runs.`);
} finally {
  await browser?.close();
  app?.stop();
  rmSync(owned, { recursive: true, force: true });
}
