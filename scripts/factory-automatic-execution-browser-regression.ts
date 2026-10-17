/** Accepted plan to named worker/check progress through the real desktop/mobile client. */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import type { Browser } from "playwright-core";
import { capacityFixture } from "./factory-capacity-fixture.ts";
import { until } from "./factory-human-review-fixture.ts";

/** Native state changes remain authoritative while every built-in label follows the selected language. */
export async function automaticLabelsJourney(browser: Browser, viewport: { width: number; height: number }) {
  const f = await capacityFixture({ advancingHeads: true });
  const setup = await browser.newContext({ viewport });
  let releaseCheck = () => {};
  const observations: { language: string; name: string; actual: string; expected: string }[] = [];
  const labels = [
    { language: "tr", capacity: "Fabrika kapasitesi", execution: "Otomatik yürütme", implementing: "Uygulanıyor", implementer: "Uygulayıcı", running: "Çalışıyor", finished: "Tamamlanan deneme", checked: "Kontroller geçti", checks: "Denetimler", testing: "Test ediliyor", passed: "Geçti", failed: "Başarısız", standards: "Standartlar", spec: "Şartname" },
    { language: "en", capacity: "Factory capacity", execution: "Automatic execution", implementing: "Implementing", implementer: "Implementer", running: "Running", finished: "Finished attempt", checked: "Checks passed", checks: "Checks", testing: "Testing", passed: "Passed", failed: "Failed", standards: "Standards", spec: "Spec" },
    { language: "ko", capacity: "팩토리 용량", execution: "자동 실행", implementing: "구현 중", implementer: "구현 담당", running: "실행 중", finished: "완료된 시도", checked: "검사 통과", checks: "검증 결과", testing: "테스트 중", passed: "통과", failed: "실패", standards: "규약", spec: "명세" },
    { language: "ja", capacity: "ファクトリーの容量", execution: "自動実行", implementing: "実装中", implementer: "実装担当", running: "実行中", finished: "完了した試行", checked: "チェック合格", checks: "検証結果", testing: "テスト中", passed: "合格", failed: "失敗", standards: "規約", spec: "仕様" },
    { language: "zh", capacity: "工厂容量", execution: "自动执行", implementing: "实现中", implementer: "实现者", running: "运行中", finished: "已完成的尝试", checked: "检查通过", checks: "检查结果", testing: "测试中", passed: "通过", failed: "失败", standards: "规范", spec: "规格" },
  ];
  try {
    await f.api("/settings", { max_agents: 1 });
    const id = await f.assignment("Localized result"); const prefix = `/implementations/${id}`;
    const detail = () => f.api(prefix).then(response => response.json());
    await f.api(`/projects/${(await detail()).implementation.project_id}/configure`, { checks: [["bun", "test"]], permissions: "Owned locale fixtures" });
    const specification = await f.api(`${prefix}/specifications`, { content: "Show retained work progress in the selected language" }).then(response => response.json());
    const origin = `http://localhost:${f.app.port}`;
    assert.equal((await setup.request.post(`${origin}/api/auth`, { data: { token: f.token } })).status(), 204);
    const entry = await setup.newPage(); entry.setDefaultTimeout(10000);
    await entry.goto(`${origin}/#factory/${id}`);
    await entry.getByRole("region", { name: "Specifications", exact: true }).getByRole("button", { name: "Accept specification", exact: true }).click();
    const accepted = await until(detail, d => d.runs.length === 1); const run = accepted.runs[0];
    assert.equal((await f.agent(run.id, "tickets", { specification_id: specification.id, testing_plan: "Public HTTP and desktop/mobile locale UI", tickets: [{ key: "one", title: "Localized result", acceptance: "Translated built-in progress labels", dependencies: [] }] })).status, 201);
    f.runs.get(run.id)!.condition = "ready";
    const active = await until(detail, d => d.automatic_execution[0]?.condition === "executing" && d.workers.some((worker: any) => worker.role === "implementer" && worker.condition === "working"));
    const worker = active.workers.find((worker: any) => worker.role === "implementer");
    const capture = async (phase: "executing" | "testing" | "checked" | "reports") => {
      for (const label of labels) {
        const context = await browser.newContext({ viewport, isMobile: viewport.width < 640, hasTouch: viewport.width < 640 });
        try {
          await context.addInitScript(language => localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language })), label.language);
          assert.equal((await context.request.post(`${origin}/api/auth`, { data: { token: f.token } })).status(), 204);
          const page = await context.newPage(); page.setDefaultTimeout(10000);
          const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
          await page.goto(`${origin}/#factory/${id}`);
          const progress = page.getByRole("region", { name: label.execution, exact: true }); await progress.waitFor();
          const record = (name: string, actual: string, expected: string) => observations.push({ language: label.language, name: `${phase}:${name}`, actual, expected });
          if (phase === "executing" || phase === "testing") {
            const capacity = page.getByRole("region", { name: label.capacity, exact: true });
            const rows = await capacity.locator(phase === "executing" ? ":scope > .factory-capacity-reservations > li" : ":scope > .factory-capacity-reservations > li > div").allTextContents();
            const expected = phase === "executing" ? ` · ${label.running} · ` : ` · ${label.running}`;
            record(phase === "executing" ? "agent reservation" : "build reservation", rows.some(text => phase === "executing" ? text.includes(expected) : text.endsWith(expected)) ? expected : rows.join(" | "), expected);
          }
          if (phase === "executing" || phase === "checked") {
            record("execution state", await progress.locator(":scope > p[role=status] > strong").innerText(), phase === "executing" ? label.implementing : label.checked);
            record("implementation worker", await progress.getByRole("article").filter({ hasText: "Localized result" }).locator("p").first().innerText(), `${label.implementer} · ${phase === "executing" ? label.running : label.finished}`);
          }
          if (phase === "testing" || phase === "checked") {
            const summaries = await progress.locator("details.factory-section > summary").allTextContents();
            const expected = `${label.checks} · ${phase === "testing" ? label.testing : label.passed} · `;
            record("check state", summaries.some(text => text.startsWith(expected)) ? expected : summaries.join(" | "), expected);
          }
          if (phase === "checked") record("Standards worker", await progress.getByRole("article").filter({ has: page.getByText(label.standards, { exact: true }) }).locator("p").first().innerText(), `${label.standards} · ${label.running}`);
          if (phase === "reports") {
            const summaries = await progress.locator("details.factory-message > summary").allTextContents();
            for (const [axis, outcome] of [[label.standards, label.failed], [label.spec, label.passed]]) {
              const expected = `${axis} · ${outcome} · `;
              record("independent report", summaries.some(text => text.startsWith(expected)) ? expected : summaries.join(" | "), expected);
            }
            record("Spec worker", await progress.getByRole("article").filter({ has: page.getByText(label.spec, { exact: true }) }).locator("p").first().innerText(), `${label.spec} · ${label.finished}`);
          }
          assert.deepEqual(errors, []); assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        } finally { await context.close(); }
      }
    };
    await capture("executing");
    const check = f.holdNextCheck("integration"); releaseCheck = check.release;
    f.workers.get(worker.id)!.condition = "ready"; await check.started; await capture("testing");
    check.release();
    const checking = await until(detail, d => d.automatic_execution[0]?.condition === "checked" && d.workers.some((worker: any) => worker.role === "standards" && worker.condition === "working"));
    await capture("checked");
    const standards = checking.workers.find((worker: any) => worker.role === "standards");
    f.reviewOutcomes.set(standards.id, "failed"); f.workers.get(standards.id)!.condition = "ready";
    const reviewing = await until(detail, d => d.workers.some((worker: any) => worker.role === "spec" && worker.condition === "working"));
    const spec = reviewing.workers.find((worker: any) => worker.role === "spec"); f.workers.get(spec.id)!.condition = "ready";
    await until(detail, d => d.review_evidence.length === 2 && d.automatic_review[0]?.condition === "repairing");
    await capture("reports");
    console.log(JSON.stringify({ viewport: viewport.width, localized_progress_observations: observations }));
    for (const observation of observations) assert.equal(observation.actual, observation.expected, `${observation.language} ${observation.name}`);
    assert.deepEqual((await detail()).approvals, accepted.approvals);
    console.log(`PASS actual execution, worker/check states and passed/failed independent reports in all five languages (${viewport.width})`);
  } finally { releaseCheck(); await setup.close(); f.close(); }
}

if (import.meta.main) {
const browser = await chromium.launch({ executablePath: process.env["CHROME_PATH"] || chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
try {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const f = await capacityFixture();
    const context = await browser.newContext({ viewport, isMobile: viewport.width < 640, hasTouch: viewport.width < 640 });
    try {
      await f.api("/settings", { max_agents: 1 });
      const id = await f.assignment("Automatic result"); const prefix = `/implementations/${id}`;
      const detail = () => f.api(prefix).then(r => r.json());
      await f.api(`/projects/${(await detail()).implementation.project_id}/configure`, { checks: [["bun", "test"]], permissions: "Owned fixtures only" });
      await f.api(`${prefix}/specifications`, { content: "Implement the accepted result" });
      const origin = `http://localhost:${f.app.port}`;
      assert.equal((await context.request.post(`${origin}/api/auth`, { data: { token: f.token } })).status(), 204);
      const page = await context.newPage(); page.setDefaultTimeout(10_000);
      const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
      await page.goto(`${origin}/#factory/${id}`);
      await page.getByRole("region", { name: "Specifications", exact: true }).getByRole("button", { name: "Accept specification", exact: true }).click();
      let run;
      const deadline = Date.now() + 10000;
      while (!run) {
        const observed = await detail(); run = observed.runs.find((r: { condition: string }) => r.condition === "working");
        if (Date.now() > deadline) throw new Error(`Orchestrator did not start: ${JSON.stringify(observed.automatic_planning)}`);
        if (!run) await Bun.sleep(20);
      }
      const spec = (await detail()).specifications[0];
      assert.equal((await f.agent(run.id, "tickets", { specification_id: spec.id, testing_plan: "Public API and desktop/mobile browser journeys", tickets: [
        { key: "one", title: "Implement the accepted result", acceptance: "Return the accepted behavior", dependencies: [] },
      ] })).status, 201);
      f.runs.get(run.id)!.condition = "ready";
      const progress = page.getByRole("region", { name: "Automatic execution", exact: true });
      await progress.getByText("Implement the accepted result", { exact: true }).waitFor();
      assert.equal(await progress.getByRole("button", { name: "Start Ticket worker", exact: true }).count(), 0);
      await page.waitForFunction(async prefix => (await fetch(`/api/factory${prefix}`).then(r => r.json())).workers.some((w: { condition: string }) => w.condition === "working"), prefix);
      const worker = (await detail()).workers[0];
      const controls = page.getByRole("region", { name: "Assignment execution", exact: true });
      f.offline(true);
      const retrying = await until(detail, d => d.automatic_execution[0]?.condition === "waiting" && !!d.automatic_execution[0].reason);
      const failure = retrying.automatic_execution[0].reason;
      await progress.getByText(failure, { exact: false }).first().waitFor();
      await progress.getByRole("alert").filter({ hasText: failure }).waitFor();
      assert.equal(await progress.getByRole("status").filter({ hasText: failure }).count(), 0);
      await page.reload();
      await progress.getByRole("alert").filter({ hasText: failure }).waitFor();
      await progress.getByRole("alert").filter({ hasText: "automatic recovery exhausted after six observations" }).waitFor({ timeout: 45_000 });
      const exhausted = (await detail()).automatic_execution[0];
      assert.equal(exhausted.attempts, 6);
      assert.equal((await detail()).workers[0].id, worker.id);
      await controls.getByRole("button", { name: "Pause Assignment", exact: true }).click();
      await controls.getByText("Pause pending", { exact: true }).waitFor();
      f.offline(false);
      await controls.getByText("Paused", { exact: true }).waitFor();
      await progress.getByText("Paused", { exact: true }).first().waitFor();
      await controls.getByRole("button", { name: "Resume Assignment", exact: true }).click();
      const resumeDeadline = Date.now() + 10000;
      for (;;) {
        const current = (await detail()).workers.find((w: { id: string }) => w.id === worker.id);
        if (!current.suspension && current.condition === "working") break;
        if (Date.now() > resumeDeadline) throw new Error("The retained Ticket did not resume");
        await Bun.sleep(20);
      }
      f.workers.get(worker.id)!.condition = "needs_you";
      f.workers.get(worker.id)!.waiting_reason = "Owned native permission required";
      await progress.getByText("Owned native permission required", { exact: true }).first().waitFor();
      await progress.getByRole("status").filter({ hasText: "Owned native permission required" }).first().waitFor();
      assert.equal(await progress.getByRole("alert").filter({ hasText: "Owned native permission required" }).count(), 0);
      const checkGate = f.holdNextCheck("integration");
      f.workers.get(worker.id)!.condition = "ready";
      f.workers.get(worker.id)!.waiting_reason = null;
      await checkGate.started;
      await controls.getByRole("button", { name: "Pause Assignment", exact: true }).click();
      await controls.getByText("Paused", { exact: true }).waitFor();
      const interrupted = (await detail()).checks.at(-1);
      assert.equal(interrupted.condition, "cancelled");
      await page.reload();
      await controls.getByRole("button", { name: "Resume Assignment", exact: true }).click();
      await page.waitForFunction(async prefix => !(await fetch(`/api/factory${prefix}`).then(r => r.json())).runs[0].suspension, prefix);
      f.runs.get(run.id)!.condition = "ready";
      await progress.getByText("Checks passed", { exact: true }).waitFor();
      const checks = progress.locator("details").filter({ has: page.locator("summary", { hasText: "Checks" }) });
      assert.equal(await checks.count(), 3);
      const checked = (await detail()).checks.at(-1);
      assert.equal(checked.head, interrupted.head); assert.equal(checked.workspace_hash, interrupted.workspace_hash);
      assert.equal(checked.condition, "passed");
      await checks.first().locator("summary").click();
      await checks.first().getByText("Owned checks passed", { exact: true }).waitFor();
      await page.reload();
      await progress.getByText("Checks passed", { exact: true }).waitFor();
      assert.equal(await progress.getByRole("alert").filter({ hasText: failure }).count(), 0);
      await progress.getByText("Implement the accepted result", { exact: true }).waitFor();
      assert.equal((await detail()).workers.filter((w: { role: string }) => w.role === "implementer").length, 1);
      assert.equal((await detail()).approvals.length, 1);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.deepEqual(errors, []);
    } finally { await context.close(); f.close(); }
  }
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) await automaticLabelsJourney(browser, viewport);
  console.log("PASS automatic execution, exhausted Machine recovery through Pause/Resume, named workers, native gate, checks and reload on desktop/mobile at cap one");
} finally { await browser.close(); }
}
