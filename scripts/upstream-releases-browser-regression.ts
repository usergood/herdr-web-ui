/** Real desktop/mobile journeys against owned HTTP and native GitHub fixtures. */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { chromium } from "playwright-core";
import { githubScheduleFixture } from "../server/github-schedules.fixture.ts";
import { factoryMergeFixture } from "../server/factory-merge.fixture.ts";

const f = await githubScheduleFixture();
assert.equal((await f.request(f.route + "/configure", f.policy)).status, 200);
const browser = await chromium.launch({ executablePath: process.env["CHROME_PATH"] || chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
const errors: string[] = [];
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.on("pageerror", error => errors.push(error.message)); page.setDefaultTimeout(10000);
try {
  const projectId = f.route.split("/")[2]!;
  await page.goto(f.origin() + `/#projects/${projectId}/settings`);
  await page.getByRole("tab", { name: "GitHub", exact: true }).click();
  await page.getByRole("textbox", { name: "Upstream repository (owner/name)", exact: true }).fill("fictional/upstream");
  const configured = page.waitForResponse(response => response.url().endsWith(f.route + "/configure"));
  await page.getByRole("button", { name: "Save Project settings", exact: true }).click(); assert.equal((await configured).status(), 200);
  const schedule = page.getByRole("region", { name: "Upstream sync schedule", exact: true });
  const run = async () => {
    const response = page.waitForResponse(response => response.url().endsWith(f.route + "/schedules/run"));
    await schedule.getByRole("button", { name: "Run now", exact: true }).click();
    assert.equal((await response).status(), 200);
  };
  await run(); await schedule.getByText("Succeeded", { exact: true }).waitFor();
  assert.equal((await f.request("")).body.implementations.length, 0);
  for (const id of [11, 12, 13]) {
    writeFileSync(f.responses, JSON.stringify({ releases: [{ id, tag_name: `v${id}`, draft: false, published_at: `2026-10-${id}T09:00:00Z` }], release_heads: { [`v${id}`]: id.toString(16).repeat(40) } }));
    await run();
  }
  await run();
  await page.goto(f.origin() + `/#projects/${projectId}`);
  const upstream = page.getByRole("region", { name: "Upstream releases", exact: true });
  await upstream.getByText("Next release: v13", { exact: false }).waitFor();
  const active = upstream.getByRole("link", { name: "Active update: v11", exact: true });
  await active.focus(); await page.keyboard.press("Enter");
  await page.getByRole("heading", { name: "Update from fictional/upstream v11", exact: true }).waitFor();
  // Arrange the retained legacy outcome through HTTP; current owner controls are Pause/Delete.
  assert.equal(await page.getByRole("button", { name: "Discard Assignment", exact: true }).count(), 0);
  const activeId = (await f.request(f.route + "/schedules")).body.upstream.active.implementation_id;
  assert.equal((await f.request(`/implementations/${activeId}/discard`, {})).status, 200);
  await page.goto(f.origin() + `/#projects/${projectId}`);
  await upstream.getByRole("link", { name: "Active update: v13", exact: true }).waitFor();
  assert.equal(await upstream.getByRole("link", { name: "Active update: v12", exact: true }).count(), 0);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await upstream.evaluate(element => element.scrollWidth <= element.clientWidth + 1), true);
    await upstream.getByText("Detected release: v13", { exact: false }).waitFor();
    await upstream.getByText("Succeeded", { exact: true }).waitFor();
  }
  assert.equal((await f.request("")).body.implementations.length, 2);
  const state = (await f.request(f.route + "/schedules")).body.upstream;
  assert.equal((await f.request(`/implementations/${state.active.implementation_id}`)).body.runs.length, 0);

  writeFileSync(f.responses, JSON.stringify({ releases: "Owned invalid upstream release inventory" }));
  const failedSync = await f.request(f.route + "/schedules/run", { job: "upstream_sync" });
  assert.equal(failedSync.status, 409);
  assert.equal(failedSync.body.error.code, "github_invalid_response");
  const failedResult = (await f.request(f.route + "/schedules")).body.results.filter((result: { job: string }) => result.job === "upstream_sync").at(-1);
  assert.equal(failedResult.condition, "failed");
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport); await page.reload();
    const alert = upstream.getByRole("alert");
    await alert.getByText("Failed", { exact: true }).waitFor();
    await alert.getByText("GitHub did not return upstream releases", { exact: true }).waitFor();
    assert.equal(await upstream.getByRole("status").filter({ hasText: "Failed" }).count(), 0);
  }
  writeFileSync(f.responses, JSON.stringify({ releases: [{ id: 13, tag_name: "v13", draft: false, published_at: "2026-10-13T09:00:00Z" }], release_heads: { v13: "d".repeat(40) } }));
  assert.equal((await f.request(f.route + "/schedules/run", { job: "upstream_sync" })).status, 200);
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport); await page.reload();
    await upstream.getByRole("status").getByText("Succeeded", { exact: true }).waitFor();
    assert.equal(await upstream.getByRole("alert").count(), 0);
  }

  const merged = await factoryMergeFixture(false, "merge", true, {}, true);
  try {
    const route = `/projects/${merged.project.id}/github`;
    merged.data["repos/fictional/upstream/releases?per_page=30&page=1"] = [{ id: 102, tag_name: "v2", draft: false, published_at: "2026-10-13T09:00:00Z" }];
    merged.data["repos/fictional/upstream/commits/v2"] = { sha: "e".repeat(40) }; merged.respond();
    assert.equal((await merged.request(route + "/schedules/run", { job: "upstream_sync" })).status, 200);
    await merged.request(merged.prefix + "/delivery", merged.links);
    const origin = `http://localhost:${merged.app.port}`;
    await page.goto(origin + `/#factory/${merged.run.implementation_id}`);
    const synced = page.waitForResponse(response => response.url().endsWith("/delivery/sync"));
    await page.getByRole("button", { name: "Sync delivery evidence", exact: true }).click(); assert.equal((await synced).status(), 200);
    await page.goto(origin + `/#projects/${merged.project.id}`);
    await page.getByRole("region", { name: "Upstream releases", exact: true }).getByRole("link", { name: "Active update: v2", exact: true }).waitFor();
    assert.equal(merged.calls().every(call => !call.args.includes("--method") && !call.args.some(arg => arg.endsWith("/merge"))), true);
  } finally { await merged.close(); }
  assert.deepEqual(errors, []);
  console.log("Upstream browser: release checks, fixed active scope, newest candidate, Discard/merge follow-up and mobile board passed");
} catch (error) {
  console.error({ url: page.url(), errors, text: (await page.locator("body").innerText()).slice(0, 6000) }); throw error;
} finally { await browser.close(); f.close(); }
