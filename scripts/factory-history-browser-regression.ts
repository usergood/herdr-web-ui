import "./test-herdr.ts";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { factoryHistoryFixture, historicalChangeEvidence, historicalDeliveryScope, historicalMerge, historicalRelease } from "../server/factory-history.fixture.ts";

const f = factoryHistoryFixture([
  { id: "unverified-history", title: "Historical repository work", delivery_scope: historicalDeliveryScope, completion_evidence: historicalChangeEvidence, delivery: { ...historicalMerge, condition: "linked", pulls: [] } },
  { id: "merged-history", title: "Delivered merge", outcome: "merged", delivery_scope: historicalDeliveryScope, completion_evidence: historicalChangeEvidence, delivery: historicalMerge },
  { id: "released-history", title: "Delivered release", outcome: "released", delivery_scope: { ...historicalDeliveryScope, milestone: "release" }, completion_evidence: historicalChangeEvidence, delivery: historicalRelease },
  { id: "research-history", title: "Accepted research", outcome: "research_accepted", completion_evidence: { repository_changes: "none", quiescent: true, reason: null, checked_at: "2026-09-01T12:00:00Z" } },
  { id: "discarded-history", title: "Discarded history", outcome: "discarded", discard_requested_at: "2026-09-01T12:00:00Z" },
  { id: "archived-history", title: "Archived history", archived_at: "2026-09-02T12:00:00Z" },
], [], true);
const browser = await chromium.launch({ executablePath: process.env["CHROME_PATH"] || chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10_000);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const navigate = (hash: string) => page.goto(`http://localhost:${f.app.port}/#${hash}`);
  await navigate("projects/history-project");
  const done = page.getByRole("region", { name: "Done", exact: true });
  for (const title of ["Delivered merge", "Delivered release", "Accepted research", "Discarded history"]) await done.getByRole("button", { name: title, exact: true }).waitFor();
  assert.equal(await done.getByRole("button", { name: "Archived history", exact: true }).count(), 0);
  const navigation = page.getByRole("navigation", { name: "Projects", exact: true });
  await navigation.getByText("Historical repository work", { exact: true }).waitFor();
  for (const title of ["Delivered merge", "Delivered release", "Accepted research", "Discarded history", "Archived history"]) assert.equal(await navigation.getByText(title, { exact: true }).count(), 0);
  await page.getByRole("region", { name: "Needs you", exact: true }).getByRole("button", { name: "Historical repository work", exact: true }).click();
  const next = page.getByRole("region", { name: "Next step", exact: true });
  const reason = "Historical completion includes repository changes without verified delivery. Inspect retained work, correct delivery links or discard this Assignment.";
  await next.getByText(reason, { exact: true }).first().waitFor();
  const delivery = next.getByRole("region", { name: "Delivery evidence", exact: true });
  await delivery.getByRole("textbox", { name: "Delivery PR numbers", exact: true }).waitFor();
  assert.equal(await delivery.getByRole("textbox", { name: "Delivery PR numbers", exact: true }).inputValue(), "12");
  await delivery.getByRole("textbox", { name: "Delivery PR numbers", exact: true }).fill("13");
  assert.equal(await delivery.getByRole("textbox", { name: "Delivery PR numbers", exact: true }).inputValue(), "13");
  assert.equal(await delivery.getByText("Verified merge", { exact: true }).count(), 0);
  assert.equal(await next.getByRole("button", { name: "Accept research", exact: true }).isEnabled(), false);
  await page.locator("summary").filter({ hasText: /^Advanced controls$/ }).first().click();
  await page.getByRole("region", { name: "Past attempts", exact: true }).getByText("Implementing", { exact: true }).waitFor();
  await page.locator(".factory-message").getByText("Keep my historical context", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await page.getByText("Retained research artifact", { exact: true }).waitFor();
  await page.reload();
  await next.getByText(reason, { exact: true }).first().waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await delivery.evaluate(el => el.scrollWidth <= el.clientWidth), "Historical delivery correction fits a phone");
  const remove = page.getByRole("button", { name: "Delete Assignment", exact: true });
  await remove.waitFor();
  assert((await remove.boundingBox())!.height >= 40, "Delete has a usable phone touch target");
  assert.equal(await page.getByRole("button", { name: "Discard Assignment", exact: true }).count(), 0);
  // Retention is the legacy oracle here; this HTTP arrangement does not exercise Delete.
  assert.equal((await f.request("/implementations/unverified-history/discard", {})).status, 200);
  await page.reload();
  await next.getByText("Discarded", { exact: true }).waitFor();
  const retained = await f.detail("unverified-history");
  assert.equal(retained.implementation.outcome, "discarded");
  assert.equal(retained.runs[0]!.id, "unverified-history-run");
  assert.equal(retained.artifacts[0]!.id, "unverified-history-artifact");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await navigation.getByText("Historical repository work", { exact: true }).waitFor({ state: "detached" });
  await navigate("projects/history-project");
  await done.getByRole("button", { name: "Historical repository work", exact: true }).waitFor();
  await page.getByRole("button", { name: "Archived tasks", exact: true }).click();
  await done.getByRole("button", { name: "Archived history", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  const restored = page.waitForResponse(r => r.url().endsWith("/implementations/archived-history/restore") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  assert.equal((await restored).status(), 200);
  await page.getByRole("button", { name: "Delete Assignment", exact: true }).waitFor();
  assert.equal((await f.detail("archived-history")).board?.lane, "needs_you");
  const recovery = await f.request("/backups/prior-version-backup/restore", {}).then(r => r.json());
  f.restart(recovery.state_dir);
  await navigate("projects/history-project");
  await page.getByRole("region", { name: "Needs you", exact: true }).getByRole("button", { name: "Historical repository work", exact: true }).waitFor();
  assert.equal((await f.detail("archived-history")).implementation.archived_at, "2026-09-02T12:00:00Z");
  assert.equal((await f.detail("unverified-history")).events.filter(event => event.kind === "historical_completion_reconciled").length, 1);
  assert.deepEqual(f.starts, [], "Startup, restore and browser navigation launch no native work");
  assert.deepEqual(errors, []);
  console.log("Historical completion browser: preserved Done/archived history, desktop/phone correction and retained legacy Discard, current Delete control and restart-safe backup restore without native starts");
} finally { await browser.close(); f.close(); }
