/** Explicit owner Retry against the built app and owned HTTP/native fixtures. */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { githubQueueFixture } from "./fixtures/github-queue.ts";

const browser = await chromium.launch({ executablePath: process.env["CHROME_PATH"] || chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
const errors: string[] = [];
try {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const fixture = githubQueueFixture(true);
    const page = await browser.newPage({ viewport, extraHTTPHeaders: { authorization: "Bearer fixture-owner" } });
    page.setDefaultTimeout(10_000); page.on("pageerror", error => errors.push(error.message));
    try {
      const { route, readiness } = await fixture.setup();
      const source = (await fixture.json(route + "/sync", {})).sources[0];
      await fixture.json(route + "/issues/1/approve", { source_revision: source.revision, policy_revision: readiness.revision });
      await fixture.json(route + "/issues/1/prepare", { source_revision: source.revision });
      const current = (await fixture.json(route + "/sync", {})).sources[0];
      const path = `/implementations/${source.implementation_id}`;
      fixture.setLaunchOutcome("failed");
      const failed = await fixture.json(path + "/runs", { action: "implement-spec", idempotency_key: "browser-first-attempt", issue_scope: { source_id: source.id, source_revision: current.revision, graph_hash: current.planning.graph_hash } });
      assert.equal(failed.condition, "failed");
      await fixture.json(route + "/sync", {});
      await page.goto(fixture.origin + `/#factory/${source.implementation_id}`);
      await page.getByText("Attempt failed. Use Retry to start again.", { exact: true }).waitFor();
      const retry = page.getByRole("region", { name: "Issue planning", exact: true }).getByRole("button", { name: "Retry", exact: true });
      await retry.waitFor();
      await page.reload();
      await retry.waitFor();
      assert.deepEqual(fixture.launches, [failed.id]);
      fixture.setLaunchOutcome("lost");
      await retry.click();
      await page.getByText("Reconciliation required. Ownership remains reserved.", { exact: true }).waitFor();
      const attempts = (await fixture.json(path)).runs;
      assert.equal(attempts.length, 2);
      assert.equal(attempts[1].retry_of, failed.id);
      const contract = page.getByRole("region", { name: "Admitted issue contract", exact: true }).last();
      await contract.getByRole("button", { name: "Reconcile Run", exact: true }).click();
      await contract.getByText("Execution confirmed.", { exact: true }).waitFor();
      assert.deepEqual(fixture.launches, [failed.id, attempts[1].id]);
      assert.deepEqual((await fixture.json(path)).runs[0], failed);
      assert(await contract.evaluate(element => element.scrollWidth <= element.clientWidth));
      const evidence = process.env["UI_EVIDENCE_DIR"];
      if (evidence) { mkdirSync(evidence, { recursive: true }); await page.screenshot({ path: join(evidence, `issue-retry-${viewport.width}.png`), fullPage: true }); }
    } finally { await page.close(); fixture.close(); }
  }
  assert.deepEqual(errors, []);
  console.log("PASS: desktop/mobile failed attempt, reload without retry, explicit Retry, uncertain outcome and reconciliation with retained history");
} finally { await browser.close(); }
