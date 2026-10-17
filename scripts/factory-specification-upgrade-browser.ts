/** Historical manual approvals require fresh explicit automatic-execution acceptance. */
import assert from "node:assert/strict";
import type { Browser } from "playwright-core";
import { capacityFixture } from "./factory-capacity-fixture.ts";
import { until } from "./factory-human-review-fixture.ts";

export async function checkHistoricalSpecificationAcceptance(browser: Browser): Promise<void> {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const fixture = await capacityFixture();
    const context = await browser.newContext({ viewport, isMobile: viewport.width < 640, hasTouch: viewport.width < 640 });
    try {
      const id = await fixture.assignment("Historical approval upgrade"); const prefix = `/implementations/${id}`;
      const initial = await fixture.api(prefix).then(r => r.json());
      await fixture.api(`/projects/${initial.implementation.project_id}/configure`, { checks: [["bun", "test"]], permissions: "Edit owned files" });
      const spec = await fixture.api(prefix + "/specifications", { content: "Explicitly accept this historical Specification for automatic execution." }).then(r => r.json());
      const legacy = await fixture.api(prefix + "/approvals", { kind: "specification", revision: spec.id, scope: "Historical manual Specification acceptance" }).then(r => r.json());
      assert.notEqual(legacy.automatic_execution, true);
      await fixture.api(prefix + "/pause", {});
      let origin = `http://localhost:${fixture.app.port}`;
      assert.equal((await context.request.post(`${origin}/api/auth`, { data: { token: fixture.token } })).status(), 204);
      const page = await context.newPage(); page.setDefaultTimeout(10_000);
      const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
      await page.goto(`${origin}/#factory/${id}`);
      const specifications = page.getByRole("region", { name: "Specifications", exact: true });
      const accept = specifications.getByRole("button", { name: "Accept specification", exact: true });
      await accept.waitFor();
      const before = await fixture.api(prefix).then(r => r.json());
      assert.deepEqual(before.approvals, [legacy]); assert.equal(before.automatic_planning.length, 0); assert.equal(before.runs.length, 0);
      assert.equal(await accept.isEnabled(), true, "A manual historical approval must not disable fresh automatic-execution acceptance");
      await page.reload(); await accept.waitFor(); assert.equal(await accept.isEnabled(), true);
      const submitted = page.waitForResponse(response => response.url().endsWith(prefix + "/specification-acceptance") && response.request().method() === "POST");
      await accept.click(); const response = await submitted; assert.equal(response.status(), 201);
      assert.deepEqual(response.request().postDataJSON(), { specification_id: spec.id, hash: spec.hash, source: "button" });
      const authority = await response.json();
      assert.equal(authority.automatic_execution, true); assert.equal(authority.revision, spec.id);
      assert.deepEqual(authority.provenance, { kind: "button", specification_hash: spec.hash });
      assert.notEqual(authority.id, legacy.id);
      await specifications.getByText("Specification accepted", { exact: true }).waitFor(); assert.equal(await accept.isDisabled(), true);
      const accepted = await fixture.api(prefix).then(r => r.json());
      assert.deepEqual(accepted.approvals, [legacy, authority]); assert.deepEqual(accepted.messages, before.messages);
      assert.equal(accepted.automatic_planning.length, 1); assert.equal(accepted.runs.length, 0);
      const planId = accepted.automatic_planning[0].id;
      fixture.restart(); origin = `http://localhost:${fixture.app.port}`;
      assert.equal((await context.request.post(`${origin}/api/auth`, { data: { token: fixture.token } })).status(), 204);
      await page.goto(`${origin}/#factory/${id}`);
      await specifications.getByText("Specification accepted", { exact: true }).waitFor(); assert.equal(await accept.isDisabled(), true);
      await page.getByRole("region", { name: "Assignment execution", exact: true }).getByRole("button", { name: "Resume Assignment", exact: true }).click();
      const started = await until(async () => { const value = await fixture.api(prefix).then(r => r.json()); if (value.automatic_planning[0]?.condition === "blocked") throw new Error(`Automatic planning blocked: ${JSON.stringify(value.automatic_planning)}`); return value; }, value => value.runs.some((run: { action: string; condition: string }) => run.action === "implement-spec" && run.condition === "working"));
      assert.equal(started.runs.length, 1); assert.equal(started.automatic_planning.length, 1); assert.equal(started.automatic_planning[0].id, planId);
      assert.deepEqual(started.approvals, [legacy, authority]); assert.equal(fixture.launches.length, 1);
      assert.deepEqual(errors, []); assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      console.log(`PASS ${viewport.width}px historical manual approval permits one fresh button acceptance and automatic plan after Resume`);
    } finally { await context.close(); fixture.close(); }
  }
}
