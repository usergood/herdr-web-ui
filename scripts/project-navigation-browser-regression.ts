/** Project navigation and Inbox at the confirmed real-browser/public-HTTP seams. */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type APIResponse, type Page } from "playwright-core";
import { createServer } from "../server/index.ts";

const root = mkdtempSync(join(tmpdir(), "saurons-project-navigation-"));
const repo = join(root, "project");
mkdirSync(repo);
writeFileSync(join(repo, "README.md"), "Owned navigation fixture\n");
for (const args of [["init", "-b", "main"], ["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "initial"]]) {
  execFileSync("git", args, { cwd: repo, stdio: "ignore" });
}
const host = createServer({ port: 0, stateDir: join(root, "host-state"), token: "owned-navigation-host", machines: false, factory: { accountDiscoveryHome: root, native: {
  modelCatalog: async provider => ({ protocol: 1, provider, models: [{ id: "owned-remote-model", name: "Owned remote model", reasoning: [], default_reasoning: null }], problem: null }),
} } });
const app = createServer({ port: 0, stateDir: join(root, "state"), factory: { accountDiscoveryHome: root,
  machineEndpoint: id => id === "navigation-remote" ? { url: `http://localhost:${host.port}`, token: "owned-navigation-host" } : undefined, native: {
  modelCatalog: async provider => ({ protocol: 1, provider, models: [{ id: "owned-model", name: "Owned model with a long readable name for a narrow phone screen", reasoning: [], default_reasoning: null }], problem: null }),
} } });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
let releasePendingCapture = () => {};
async function usableControls(page: Page): Promise<void> {
  const panel = page.getByRole("region", { name: "Factory", exact: true });
  const layout = await panel.evaluate(element => {
    const boundary = element.getBoundingClientRect();
    const controls = Array.from(element.querySelectorAll<HTMLElement>("button, input, select, textarea, summary"))
      .filter(control => control.checkVisibility())
      .map(control => ({ name: control.getAttribute("aria-label") ?? control.closest("label")?.textContent ?? control.textContent, rect: control.getBoundingClientRect().toJSON(), clipped: control.scrollWidth > control.clientWidth + 1 }));
    return { width: element.clientWidth, scrollWidth: element.scrollWidth, left: boundary.left, right: boundary.right, controls };
  });
  assert(layout.scrollWidth <= layout.width + 1, "Inbox has no horizontal overflow");
  for (const control of layout.controls) {
    assert(control.rect.height >= 40 && control.rect.width >= 40, `${control.name} has a usable touch target (${control.rect.width} × ${control.rect.height})`);
    assert(control.rect.left >= layout.left && control.rect.right <= layout.right + 1, `${control.name} fits inside Inbox`);
    assert(!control.clipped, `${control.name} has readable, unclipped content`);
  }
}
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const response = await page.request.post(`http://localhost:${app.port}/api/factory/projects`, {
    headers: { "x-herdr-factory": "1" }, data: { name: "Navigation Project", path: repo, machine_id: "local", provider: "codex", tracker: "app" },
  });
  assert.equal(response.status(), 201);
  const project = await response.json();
  await page.goto(`http://localhost:${app.port}/#factory`);
  const navigation = page.getByRole("navigation", { name: "Projects", exact: true });
  await navigation.getByText(project.name, { exact: true }).first().click();
  await page.waitForFunction(id => location.hash === `#projects/${id}`, project.id);
  assert.equal(await navigation.getByText(project.name, { exact: true }).count(), 1, "The Project has one name that opens its board");
  assert.equal(await navigation.getByRole("button", { name: "Inbox", exact: true }).count(), 0);
  assert.equal(await navigation.getByRole("button", { name: "Assignments", exact: true }).count(), 0);
  assert.equal(await navigation.getByText("Inbox chat", { exact: true }).count(), 0);
  assert.equal(await navigation.getByText("Assignments", { exact: true }).count(), 0);
  const chats = navigation.getByRole("button", { name: `Project chats for ${project.name}`, exact: true });
  await chats.press("Enter");
  await navigation.getByRole("button", { name: `Project chats for ${project.name}`, exact: true, expanded: false }).waitFor();
  await navigation.getByRole("button", { name: project.name, exact: true }).click();
  await chats.press("Enter");
  await navigation.getByRole("button", { name: `Project chats for ${project.name}`, exact: true, expanded: true }).waitFor();
  const settings = page.getByRole("button", { name: `Project settings for ${project.name}`, exact: true });
  await settings.focus();
  await settings.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Project settings", exact: true });
  await dialog.waitFor();
  await dialog.getByRole("textbox", { name: "Project name", exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  await page.waitForFunction(id => location.hash === `#projects/${id}`, project.id);
  await settings.waitFor();
  assert(await settings.evaluate(element => element === document.activeElement), "Closing Project settings returns keyboard focus to the board action");
  await page.getByRole("button", { name: "Add message", exact: true }).click();
  await page.waitForFunction(id => location.hash === `#projects/${id}/inbox`, project.id);
  await page.getByRole("textbox", { name: "Idea title", exact: true }).fill("Scoped navigation idea");
  await page.getByRole("textbox", { name: "Idea notes", exact: true }).fill("Keep this idea in its selected Project.");
  const captured = page.waitForResponse(r => r.url().endsWith("/api/factory/implementations") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Capture idea", exact: true }).click();
  const ideaResponse = await captured;
  assert.equal(ideaResponse.status(), 201);
  assert.equal(ideaResponse.request().postDataJSON().project_id, project.id);
  const idea = await ideaResponse.json();
  await page.getByRole("heading", { name: idea.title, exact: true }).waitFor();
  const detail = await page.request.get(`http://localhost:${app.port}/api/factory/implementations/${idea.id}`).then(r => r.json());
  assert.equal(detail.implementation.project_id, project.id);
  assert.equal(detail.implementation.description, "Keep this idea in its selected Project.");
  await page.getByRole("banner").getByRole("button", { name: "Inbox", exact: true }).click();
  await page.waitForFunction(() => location.hash === "#factory");
  await page.getByRole("textbox", { name: "Idea title", exact: true }).waitFor();
  await page.getByRole("textbox", { name: "Idea title", exact: true }).fill("Unassigned navigation idea");
  const globalCapture = page.waitForResponse(r => r.url().endsWith("/api/factory/implementations") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Capture idea", exact: true }).click();
  assert.equal((await globalCapture).request().postDataJSON().project_id, null, "Header Inbox captures projectless ideas");
  for (const width of [390, 320]) {
    const phone = await browser.newPage({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true });
    phone.setDefaultTimeout(10_000);
    phone.on("pageerror", error => errors.push(error.message));
    await phone.goto(`http://localhost:${app.port}/#factory`);
    await phone.getByRole("textbox", { name: "Idea title", exact: true }).waitFor();
    await usableControls(phone);
    await phone.getByRole("button", { name: "Open workspace list", exact: true }).click();
    await phone.getByRole("navigation", { name: "Projects", exact: true }).getByRole("button", { name: project.name, exact: true }).click();
    await phone.waitForFunction(id => location.hash === `#projects/${id}`, project.id);
    await phone.getByRole("button", { name: `Project settings for ${project.name}`, exact: true }).click();
    const phoneSettings = phone.getByRole("dialog", { name: "Project settings", exact: true });
    await phoneSettings.getByRole("tab", { name: "Project", exact: true }).click();
    await phoneSettings.getByRole("textbox", { name: "Project name", exact: true }).waitFor();
    await phone.keyboard.press("Escape");
    await phoneSettings.waitFor({ state: "hidden" });
    await phone.getByRole("button", { name: "Add message", exact: true }).click();
    const title = phone.getByRole("textbox", { name: "Idea title", exact: true });
    await title.fill(`Phone idea ${width}`);
    await phone.setViewportSize({ width, height: 390 });
    await title.press("Tab");
    const notes = phone.getByRole("textbox", { name: "Idea notes", exact: true });
    assert(await notes.evaluate(element => element === document.activeElement), "Tab moves from the title to notes while the keyboard reduces the viewport");
    await notes.fill("A readable phone capture.");
    await notes.press("Tab");
    const capture = phone.getByRole("button", { name: "Capture idea", exact: true });
    assert(await capture.evaluate(element => element === document.activeElement), "Capture stays keyboard accessible");
    await usableControls(phone);
    await capture.press("Enter");
    await phone.getByRole("heading", { name: `Phone idea ${width}`, exact: true }).waitFor();
    await phone.getByRole("button", { name: "Start work", exact: true }).waitFor();
    await phone.getByRole("combobox", { name: "Model", exact: true }).selectOption("owned-model");
    await usableControls(phone);
    const modelRefresh = await phone.getByRole("button", { name: "Refresh model list", exact: true }).boundingBox();
    const startWork = await phone.getByRole("button", { name: "Start work", exact: true }).boundingBox();
    assert(modelRefresh && startWork && startWork.y - (modelRefresh.y + modelRefresh.height) >= 8, "Model settings and the primary action have separate touch areas");
    if (process.env.UI_EVIDENCE_DIR) {
      mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
      await phone.setViewportSize({ width, height: 844 });
      await phone.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, `project-inbox-${width}.png`), fullPage: true, animations: "disabled" });
    }
    await phone.close();
  }
  const otherRepo = join(root, "other-project");
  execFileSync("git", ["clone", "--local", repo, otherRepo], { stdio: "ignore" });
  const otherResponse = await page.request.post(`http://localhost:${app.port}/api/factory/projects`, {
    headers: { "x-herdr-factory": "1" }, data: { name: "Other navigation Project", path: otherRepo, machine_id: "navigation-remote", provider: "codex", tracker: "app" },
  });
  assert.equal(otherResponse.status(), 201);
  const otherProject = await otherResponse.json();
  await navigation.getByRole("button", { name: otherProject.name, exact: true }).waitFor();
  await navigation.getByRole("button", { name: project.name, exact: true }).click();
  await page.getByRole("button", { name: "Add message", exact: true }).click();
  await page.getByRole("textbox", { name: "Idea title", exact: true }).fill("Delayed Project idea");
  let releaseCapture!: () => void;
  const delivery = new Promise<void>(resolve => { releaseCapture = resolve; });
  releasePendingCapture = releaseCapture;
  let captureReady!: (response: APIResponse) => void;
  let readyTimeout: ReturnType<typeof setTimeout>;
  const ready = new Promise<APIResponse>((resolve, reject) => {
    captureReady = response => { clearTimeout(readyTimeout); resolve(response); };
    readyTimeout = setTimeout(() => reject(new Error("The owned capture did not reach the response boundary")), 10_000);
  });
  await page.route("**/api/factory/implementations", async route => {
    if (route.request().method() !== "POST") return route.continue();
    const result = await route.fetch();
    captureReady(result);
    await delivery;
    await route.fulfill({ response: result });
  });
  const delivered = page.waitForResponse(r => r.url().endsWith("/api/factory/implementations") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Capture idea", exact: true }).click();
  const pendingCapture = await ready;
  await navigation.getByRole("button", { name: otherProject.name, exact: true }).click();
  await page.waitForFunction(id => location.hash === `#projects/${id}`, otherProject.id);
  releaseCapture();
  await (await delivered).finished();
  const delayedIdea = await pendingCapture.json();
  const delayedDetail = await page.request.get(`http://localhost:${app.port}/api/factory/implementations/${delayedIdea.id}`).then(r => r.json());
  assert.equal(delayedDetail.implementation.project_id, project.id, "A delayed capture retains its original Project");
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  assert.equal(new URL(page.url()).hash, `#projects/${otherProject.id}`, "A completed capture cannot take navigation away from the Project the owner selected meanwhile");
  await page.unroute("**/api/factory/implementations");
  await page.getByRole("button", { name: "Add message", exact: true }).click();
  await page.getByRole("textbox", { name: "Idea title", exact: true }).fill("Remote navigation idea");
  const remoteCatalog = page.waitForRequest(request => request.url().endsWith("/api/factory/model-catalog") && request.method() === "POST");
  await page.getByRole("button", { name: "Capture idea", exact: true }).click();
  const catalogRequest = (await remoteCatalog).postDataJSON();
  assert.equal(catalogRequest.project_id, otherProject.id);
  assert.equal(catalogRequest.machine_id, "navigation-remote", "Project capture retains its owning Machine across navigation");
  await page.getByRole("combobox", { name: "Model", exact: true }).selectOption("owned-remote-model");
  assert.deepEqual(errors, []);
  console.log("Project navigation browser: desktop and 390px/320px touch navigation, keyboard Settings/capture, readable controls, global Inbox, delayed capture and remote Machine identity");
} finally {
  releasePendingCapture();
  await browser.close();
  app.stop();
  host.stop();
  rmSync(root, { recursive: true, force: true });
}
