import "./test-herdr.ts";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { factoryPublicationFixture } from "../server/factory-publication.fixture.ts";
import { upstreamConflictFixture } from "../server/upstream-conflict.fixture.ts";

const f = await factoryPublicationFixture({ upstream: true });
const browser = await chromium.launch({ executablePath: process.env["CHROME_PATH"] || chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(10000);
const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
try {
  const origin = `http://localhost:${f.app.port}`;
  await page.goto(origin + `/#factory/${f.run.implementation_id}`);
  await page.getByText("Advanced controls", { exact: true }).last().click();
  const release = page.getByRole("region", { name: "Upstream release", exact: true });
  assert.equal(await release.count(), 2, "The Specification and execution evidence both show their fixed release");
  for (const entry of await release.all()) {
    await entry.getByRole("link", { name: "fictional/upstream · v1", exact: true }).waitFor();
    await entry.getByText(f.upstreamRevision!, { exact: true }).waitFor();
  }
  f.github({ releases: [{ id: 102, tag_name: "v2", draft: false, published_at: "2026-10-13T09:00:00Z" }], release_head: "b".repeat(40) });
  assert.equal((await f.request(`/projects/${f.project.id}/github/schedules/run`, { job: "upstream_sync" })).status, 200);
  await page.reload();
  await page.getByText("Advanced controls", { exact: true }).last().click();
  assert.equal(await release.getByRole("link", { name: "fictional/upstream · v2", exact: true }).count(), 0);
  await page.getByRole("combobox", { name: "Changes", exact: true }).selectOption("branch");
  const captured = page.waitForResponse(r => r.url().endsWith(f.prefix + "/snapshots") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Capture review", exact: true }).click(); assert.equal((await captured).status(), 201);
  await page.getByRole("heading", { name: /^feature\.md · / }).waitFor();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    for (const entry of await release.all()) assert(await entry.evaluate(el => el.scrollWidth <= el.clientWidth + 1), "Pinned release fits a phone");
  }
  assert.equal(f.uploads.length, 0);
  await f.verify();
  assert.equal((await f.request(`/runs/${f.run.id}/accept`, { head: f.head })).status, 200);
  await page.reload();
  const publication = page.getByRole("region", { name: "Implementation PR", exact: true });
  const publish = publication.getByRole("button", { name: "Publish PR", exact: true });
  await publication.getByText("fictional/project · main", { exact: true }).waitFor(); assert.equal(f.uploads.length, 0);
  const published = page.waitForResponse(r => r.url().endsWith(f.route + "/publish"));
  await publish.focus(); await page.keyboard.press("Enter"); assert.equal((await published).status(), 200);
  await publication.getByRole("link", { name: "PR #42", exact: true }).waitFor();
  assert.equal((await f.request(f.prefix).then(r => r.json())).board.lane, "needs_you");
  assert(f.calls().every(call => !call.args.some(arg => /\/(merge|releases|deployments)$/.test(arg))));
  const conflict = await upstreamConflictFixture();
  try {
    conflict.restart();
    await page.goto(`http://localhost:${conflict.app.port}/#factory/${conflict.run.implementation_id}`);
    await page.getByText(conflict.question.question, { exact: true }).first().waitFor();
    await page.setViewportSize({ width: 320, height: 844 });
    await page.getByRole("textbox", { name: "Your answer", exact: true }).fill("Keep the fork behavior and incorporate only v1.");
    const answered = page.waitForResponse(r => r.url().endsWith(`/questions/${conflict.question.id}/answer`));
    await page.getByRole("button", { name: "Save answer", exact: true }).click(); assert.equal((await answered).status(), 200);
    await page.getByText("Keep the fork behavior and incorporate only v1.", { exact: true }).waitFor();
    const contract = await conflict.agent("contract").then(r => r.json());
    assert.equal((await conflict.agent("consume", { revision: contract.question_revision })).status, 200);
    const head = conflict.resolve();
    await conflict.verify();
    assert.equal((await conflict.request(`/runs/${conflict.run.id}/accept`, { head })).status, 200);
    await page.reload();
    const recovered = page.getByRole("region", { name: "Implementation PR", exact: true });
    await recovered.getByRole("button", { name: "Publish PR", exact: true }).waitFor();
    assert.equal(conflict.uploads.length, 0);
    const detail = await conflict.request(conflict.prefix).then(r => r.json());
    assert.equal(detail.runs.length, 1);
    assert.equal(detail.runs[0].worktree, conflict.run.worktree);
    assert.equal(detail.runs[0].manifest.specification.upstream_update.revision, conflict.upstreamRevision);
    assert.equal(detail.board.activity, "awaiting_merge");
  } finally { await page.waitForLoadState("networkidle"); await page.close(); await conflict.close(); }
  assert.deepEqual(errors, []);
  console.log("Upstream preparation browser: fixed release, newer candidate, isolated diff, phone layout, explicit publication and conflict/restart/owner-answer recovery passed");
} catch (error) {
  console.error({ url: page.url(), errors, text: page.isClosed() ? "Owned fixture page closed" : (await page.locator("body").innerText()).slice(0, 5000) }); throw error;
} finally { await browser.close(); await f.close(); }
