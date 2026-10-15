/** Authenticated desktop/touch journeys with owned public Machine HTTP fixtures. */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { capacityFixture } from "./factory-capacity-fixture.ts";

const fixture = await capacityFixture();
const browser = await chromium.launch({ executablePath: process.env["CHROME_PATH"] || chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
try {
  await fixture.api("/settings", { max_agents: 1, max_builds: 2 });
  const workId = await fixture.assignment("Occupied implementation", "codex", "owned-a");
  assert.equal((await fixture.api(`/implementations/${workId}/runs`, { action: "work", idempotency_key: "work" })).status, 202);
  const interviewId = await fixture.assignment("Uncertain interview", "claude", "owned-b");
  fixture.loseNextLaunch();
  const interview = await fixture.api(`/implementations/${interviewId}/runs`, { action: "grill-with-docs", idempotency_key: "interview" }).then(r => r.json());
  assert.equal(interview.condition, "disconnected");
  const waitingId = await fixture.assignment("Waiting Specification", "opencode", "owned-c");
  assert.equal((await fixture.api(`/implementations/${waitingId}/runs`, { action: "to-spec", idempotency_key: "waiting" })).status, 409);
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport, isMobile: viewport.width < 640, hasTouch: viewport.width < 640 });
    const origin = `http://localhost:${fixture.app.port}`;
    assert.equal((await context.request.post(`${origin}/api/auth`, { data: { token: fixture.token } })).status(), 204);
    const page = await context.newPage(); page.setDefaultTimeout(8_000);
    const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
    await page.goto(`${origin}/#assignments`);
    const capacity = page.getByRole("region", { name: "Factory capacity", exact: true });
    await capacity.getByText("Agent contexts: 1/1", { exact: true }).waitFor();
    await capacity.getByText("Extra planning context: 1/1", { exact: true }).waitFor();
    await capacity.getByText("Builds: 0/2", { exact: true }).waitFor();
    await capacity.getByText("Uncertain interview", { exact: true }).waitFor();
    await capacity.getByRole("link", { name: "Waiting Specification", exact: true }).waitFor();
    await capacity.getByRole("listitem").filter({ hasText: "Waiting for agent capacity" }).waitFor();
    await capacity.getByText("Execution uncertain; reservation retained", { exact: true }).waitFor();
    assert.match(await capacity.innerText(), /owned-b/); assert.match(await capacity.innerText(), /claude/);
    await page.getByText("Factory settings and recovery", { exact: true }).click();
    assert.equal(await page.getByRole("spinbutton", { name: "Concurrent Implementations", exact: true }).count(), 0);
    const agents = page.getByRole("spinbutton", { name: "Agent context limit", exact: true });
    assert.equal(await agents.inputValue(), "1");
    await agents.fill("2");
    const saved = page.waitForResponse(r => r.url().endsWith("/api/factory/settings") && r.request().method() === "POST");
    await page.getByRole("button", { name: "Save factory settings", exact: true }).click();
    assert.equal((await saved).status(), 200);
    await capacity.getByText("Agent contexts: 1/2", { exact: true }).waitFor();
    await page.reload(); await page.getByText("Factory settings and recovery", { exact: true }).click();
    assert.equal(await page.getByRole("spinbutton", { name: "Agent context limit", exact: true }).inputValue(), "2");
    assert.equal(await page.getByRole("spinbutton", { name: "Build limit", exact: true }).inputValue(), "2");
    assert.deepEqual(errors, []);
    await context.close();
    await fixture.api("/settings", { max_agents: 1 });
  }
  console.log("PASS global capacity desktop/mobile controls and uncertain reservations");
} finally { await browser.close(); fixture.close(); }
