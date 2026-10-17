/** Authenticated desktop/touch journeys with owned public Machine HTTP fixtures. */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { capacityFixture } from "./factory-capacity-fixture.ts";
import { until } from "./factory-human-review-fixture.ts";
import { checkQueuedMachineErrors } from "./factory-capacity-error-browser.ts";

const browser = await chromium.launch({ executablePath: process.env["CHROME_PATH"] || chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
try {
  await checkQueuedMachineErrors(browser);
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const fixture = await capacityFixture();
    const context = await browser.newContext({ viewport, isMobile: viewport.width < 640, hasTouch: viewport.width < 640 });
    try {
      await fixture.api("/settings", { max_agents: 1, max_builds: 2 });
      const workId = await fixture.assignment("Occupied implementation", "codex", "owned-a");
      const work = await fixture.api(`/implementations/${workId}/runs`, { action: "work", idempotency_key: "work" }).then(r => r.json());
      const waitingId = await fixture.assignment("Waiting work", "opencode", "owned-c");
      const origin = `http://localhost:${fixture.app.port}`;
      assert.equal((await context.request.post(`${origin}/api/auth`, { data: { token: fixture.token } })).status(), 204);
      const page = await context.newPage(); page.setDefaultTimeout(10_000);
      const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
      await page.goto(`${origin}/#factory/${waitingId}`);
      const start = page.getByRole("button", { name: "Start work", exact: true });
      const submitted = page.waitForResponse(r => r.url().endsWith(`/implementations/${waitingId}/runs`) && r.request().method() === "POST");
      await start.click(); assert.equal((await submitted).status(), 202);
      const capacity = page.getByRole("region", { name: "Factory capacity", exact: true });
      await capacity.getByRole("link", { name: "Waiting work", exact: true }).waitFor();
      await capacity.getByRole("listitem").filter({ hasText: "Waiting for agent capacity" }).waitFor();
      await page.getByText("Queued work starts automatically when capacity is available.", { exact: true }).waitFor();
      assert.equal(await start.isDisabled(), true);
      const waiting = capacity.getByRole("listitem").filter({ has: page.getByRole("link", { name: "Waiting work", exact: true }) });
      const blocked = await fixture.api(`/implementations/${workId}/runs`, { action: "work", idempotency_key: "overlapping-owned-work" });
      assert.equal(blocked.status, 409);
      assert.equal((await blocked.json()).error.code, "implementation_owned");
      const blockedRow = capacity.getByRole("listitem").filter({ has: page.getByRole("link", { name: "Occupied implementation", exact: true }) });
      await blockedRow.getByRole("alert").filter({ hasText: "retains ownership" }).waitFor();
      await waiting.getByRole("status").waitFor();
      assert.equal(await waiting.getByRole("alert").count(), 0);
      await page.reload();
      await page.getByText("Queued work starts automatically when capacity is available.", { exact: true }).waitFor();
      await fixture.api(`/runs/${work.id}/stop`, {});
      await capacity.getByRole("link", { name: "Waiting work", exact: true }).waitFor({ state: "detached" });
      await capacity.getByText("Waiting work", { exact: true }).waitFor();
      await capacity.getByText("Agent contexts: 1/1", { exact: true }).waitFor();
      const running = capacity.getByRole("listitem").filter({ has: page.getByText("Waiting work", { exact: true }) });
      assert.match(await running.innerText(), / · Running · /);
      const started = await fixture.api(`/implementations/${waitingId}`).then(response => response.json());
      assert.equal(started.runs.at(-1).condition, "working");
      assert.equal(fixture.launches.length, 2);
      assert.deepEqual(errors, []);
    } finally { await context.close(); fixture.close(); }

    const blockedFixture = await capacityFixture();
    const blockedContext = await browser.newContext({ viewport, isMobile: viewport.width < 640, hasTouch: viewport.width < 640 });
    try {
      const id = await blockedFixture.assignment("Blocked retained conversation");
      const run = await blockedFixture.api(`/implementations/${id}/runs`, { action: "work", idempotency_key: "blocked-conversation" }).then(r => r.json());
      await blockedFixture.api(`/implementations/${id}/questions`, { run_id: run.id, question: "Which owned result?" });
      blockedFixture.runs.get(run.id)!.condition = "ready";
      const origin = `http://localhost:${blockedFixture.app.port}`;
      assert.equal((await blockedContext.request.post(`${origin}/api/auth`, { data: { token: blockedFixture.token } })).status(), 204);
      const page = await blockedContext.newPage(); page.setDefaultTimeout(10_000);
      await page.goto(`${origin}/#factory/${id}`);
      const conversations = page.getByRole("region", { name: "Waiting conversations", exact: true });
      await conversations.getByRole("status").filter({ hasText: "Execution capacity released" }).waitFor();
      assert.equal(await conversations.getByRole("alert").count(), 0);
      blockedFixture.blockNextSend("input_draft");
      await page.getByRole("textbox", { name: "Your answer", exact: true }).fill("Preserve the native draft");
      const sent = page.waitForResponse(r => r.url().endsWith(`/runs/${run.id}/send-answers`));
      await page.getByRole("button", { name: "Save answer", exact: true }).click();
      assert.equal((await (await sent).json()).condition, "blocked");
      const overview = await blockedFixture.api("").then(r => r.json());
      const blocked = overview.capacity.continuations.find((entry: { run_id: string }) => entry.run_id === run.id);
      assert.equal(blocked.condition, "blocked");
      assert.match(blocked.reason, /draft/);
      await conversations.getByRole("alert").filter({ hasText: blocked.reason }).waitFor();
      await page.reload();
      await conversations.getByRole("alert").filter({ hasText: blocked.reason }).waitFor();
      assert.equal(blockedFixture.prompts.length, 0);
      assert.equal(blockedFixture.launches.length, 1);
    } finally { await blockedContext.close(); blockedFixture.close(); }

    const uncertainFixture = await capacityFixture();
    const uncertainContext = await browser.newContext({ viewport, isMobile: viewport.width < 640, hasTouch: viewport.width < 640 });
    try {
      await uncertainFixture.api("/settings", { max_agents: 1, max_builds: 1 });
      const id = await uncertainFixture.assignment("Uncertain build reservation");
      const run = await uncertainFixture.api(`/implementations/${id}/runs`, { action: "work", idempotency_key: "uncertain-build" }).then(r => r.json());
      uncertainFixture.loseNextCheck(); uncertainFixture.unavailableCheckObservation(true);
      const check = await uncertainFixture.api(`/runs/${run.id}/checks`, {}).then(r => r.json());
      assert.equal(check.condition, "interrupted");
      const overview = () => uncertainFixture.api("").then(r => r.json());
      const first = (await overview()).capacity;
      assert.deepEqual(first.builds, { limit: 1, used: 1 });
      assert.equal(first.build_reservations[0].id, check.id);
      assert.equal(first.build_reservations[0].uncertain, true);
      assert.equal(first.build_reservations[0].reason, null);
      console.log(JSON.stringify({ viewport: viewport.width, build: first.build_reservations[0], builds: first.builds }));
      let origin = `http://localhost:${uncertainFixture.app.port}`;
      assert.equal((await uncertainContext.request.post(`${origin}/api/auth`, { data: { token: uncertainFixture.token } })).status(), 204);
      const page = await uncertainContext.newPage(); page.setDefaultTimeout(10_000);
      const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
      await page.goto(`${origin}/#factory/${id}`);
      const capacity = page.getByRole("region", { name: "Factory capacity", exact: true });
      const uncertainText = "Execution uncertain; reservation retained";
      const buildRow = capacity.locator("li").filter({ hasText: "Build limit" });
      await capacity.getByRole("alert").filter({ hasText: "Build limit" }).getByText(uncertainText, { exact: true }).waitFor();
      assert.equal(await buildRow.getByRole("status").count(), 0);
      await page.reload();
      await capacity.getByRole("alert").filter({ hasText: "Build limit" }).getByText(uncertainText, { exact: true }).waitFor();
      uncertainFixture.restart();
      origin = `http://localhost:${uncertainFixture.app.port}`;
      assert.equal((await uncertainContext.request.post(`${origin}/api/auth`, { data: { token: uncertainFixture.token } })).status(), 204);
      await page.goto(`${origin}/#factory/${id}`);
      await capacity.getByRole("alert").filter({ hasText: "Build limit" }).getByText(uncertainText, { exact: true }).waitFor();
      const retained = (await overview()).capacity;
      assert.deepEqual(retained.builds, first.builds);
      assert.equal(retained.build_reservations[0].id, check.id);
      const blocked = await uncertainFixture.api(`/runs/${run.id}/checks`, {});
      assert.equal(blocked.status, 409);
      assert.equal((await blocked.json()).error.code, "build_capacity_exhausted");
      assert.equal(uncertainFixture.executedChecks.length, 1, "Unknown check ownership cannot replay a build");
      const executionRow = capacity.locator("li").filter({ hasText: "Normal capacity" });
      for (const condition of ["interrupted", "disconnected"] as const) {
        const native = uncertainFixture.runs.get(run.id)!;
        native.condition = condition; native.waiting_reason = null;
        assert.equal((await uncertainFixture.api(`/runs/${run.id}/reconcile`, {})).status, 200);
        const projected = (await overview()).capacity.contexts.find((entry: { id: string }) => entry.id === run.id);
        assert.equal(projected.condition, condition); assert.equal(projected.reason, null);
        await executionRow.getByRole("alert").filter({ hasText: uncertainText }).waitFor();
        assert.equal(await executionRow.getByRole("alert").count(), 1);
        native.waiting_reason = "Owned native execution could not be confirmed";
        await uncertainFixture.api(`/runs/${run.id}/reconcile`, {});
        await executionRow.getByRole("alert").filter({ hasText: native.waiting_reason }).waitFor();
        assert.equal(await executionRow.getByRole("alert").count(), 1, "An existing execution error is announced once");
      }
      uncertainFixture.runs.get(run.id)!.condition = "working";
      uncertainFixture.runs.get(run.id)!.waiting_reason = null;
      await uncertainFixture.api(`/runs/${run.id}/reconcile`, {});
      uncertainFixture.unavailableCheckObservation(false);
      const observedCheck = await uncertainFixture.api(`/runs/${run.id}/checks/${check.id}/reconcile`, {});
      assert.equal(observedCheck.status, 200);
      const passed = await observedCheck.json();
      assert.equal(passed.id, check.id); assert.equal(passed.condition, "passed");
      await until(overview, value => value.capacity.builds.used === 0);
      const heldCheck = uncertainFixture.holdNextCheck();
      const checking = uncertainFixture.api(`/runs/${run.id}/checks`, {});
      let checkEntered = false;
      void heldCheck.started.then(() => { checkEntered = true; });
      try {
        await until(async () => checkEntered, entered => entered);
        await capacity.getByRole("status").filter({ hasText: "Build limit" }).waitFor();
        assert.equal(await capacity.getByRole("alert").filter({ hasText: "Build limit" }).count(), 0);
        assert.equal((await overview()).capacity.build_reservations[0].condition, "working");
      } finally { heldCheck.release(); await checking; }
      await uncertainFixture.api(`/runs/${run.id}/stop`, {});
      const acceptedId = await uncertainFixture.assignment("Accepted ordinary reservation");
      const allocation = uncertainFixture.holdNextAllocation();
      const starting = uncertainFixture.api(`/implementations/${acceptedId}/runs`, { action: "work", idempotency_key: "accepted-reservation" });
      let allocationId: string | null = null;
      void allocation.started.then(value => { allocationId = value; });
      try {
        const acceptedRunId = await until(async () => allocationId, value => value !== null);
        const accepted = (await overview()).capacity.contexts.find((entry: { id: string }) => entry.id === acceptedRunId);
        assert.equal(accepted.condition, "accepted"); assert.equal(accepted.uncertain, true); assert.equal(accepted.reason, null);
        const acceptedRow = capacity.locator("li").filter({ hasText: "Accepted ordinary reservation" });
        await acceptedRow.getByRole("status").filter({ hasText: uncertainText }).waitFor();
        assert.equal(await acceptedRow.getByRole("alert").count(), 0, "Accepted ownership is an ordinary reservation despite the uncertainty boolean");
      } finally { allocation.release(); await starting; }
      assert.deepEqual(errors, []);
    } finally { await uncertainContext.close(); uncertainFixture.close(); }
  }
  console.log("PASS automatic queued-to-running dispatch, interrupted build ownership/alerts, ordinary reservations and reload/restart on desktop/mobile");
} finally { await browser.close(); }
