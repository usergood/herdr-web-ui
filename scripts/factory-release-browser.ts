import assert from "node:assert/strict";
import type { Browser } from "playwright-core";
import { factoryMergeFixture } from "../server/factory-merge.fixture.ts";

/** Called by the existing merge-delivery browser lane with owned HTTP/native fixtures. */
export async function checkReleaseDelivery(browser: Browser): Promise<void> {
  const f = await factoryMergeFixture(false, "release");
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  page.setDefaultTimeout(10_000);
  try {
    await page.goto(`http://localhost:${f.app.port}/#factory/${f.run.implementation_id}`);
    const delivery = page.getByRole("region", { name: "Delivery evidence", exact: true });
    await delivery.getByRole("combobox", { name: "GitHub account", exact: true }).selectOption(f.profile.id);
    await delivery.getByRole("textbox", { name: "Delivery PR numbers", exact: true }).fill("12");
    const linked = page.waitForResponse(r => r.url().endsWith(f.prefix + "/delivery") && r.request().method() === "POST");
    await delivery.getByRole("button", { name: "Save delivery links", exact: true }).click();
    assert.equal((await linked).status(), 200);
    await delivery.getByRole("button", { name: "Sync delivery evidence", exact: true }).click();
    const status = page.locator(".factory-detail > .factory-section").first();
    await status.getByRole("status", { name: "Awaiting release", exact: true }).waitFor();
    assert.equal(await status.getByRole("status", { name: "Awaiting release", exact: true }).evaluate(el => el.getAnimations({ subtree: true }).length), 0);
    await page.goto(`http://localhost:${f.app.port}/#assignments`);
    const card = page.getByRole("region", { name: "Running", exact: true }).locator(".factory-card").filter({ has: page.getByRole("button", { name: "Retained research", exact: true }) });
    await card.getByRole("status", { name: "Awaiting release", exact: true }).waitFor();
    await f.request(`/projects/${f.project.id}/configure`, { delivery_policy: "merge" });
    const question = await f.request(f.prefix + "/questions", { question: "Resolve the required release action" }).then(r => r.json());
    await page.goto(`http://localhost:${f.app.port}/#factory/${f.run.implementation_id}`);
    await status.getByText("Needs you", { exact: true }).first().waitFor();
    await status.getByText(question.question, { exact: true }).waitFor();
    assert.equal((await f.request(f.prefix + `/questions/${question.id}/answer`, { revision: question.revision, answer: "Resolved" })).status, 200);
    delete f.data["repos/fictional/project/releases?per_page=100&page=1"]; f.respond();
    await delivery.getByRole("button", { name: "Sync delivery evidence", exact: true }).click();
    await delivery.getByRole("alert").waitFor();
    assert((await delivery.getByRole("alert").innerText()).length > 0, "Unavailable evidence has an owner-visible explanation");
    await status.getByText("Needs you", { exact: true }).first().waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    const release = { id: 42, tag_name: "v1.0.0", draft: false, published_at: "2026-10-14T12:00:00Z" };
    f.data["repos/fictional/project/releases?per_page=100&page=1"] = [release];
    f.data["repos/fictional/project/releases/42"] = release;
    f.data["repos/fictional/project/commits/tags%2Fv1.0.0"] = { sha: f.tip }; f.respond();
    await delivery.getByRole("button", { name: "Sync delivery evidence", exact: true }).click();
    const link = delivery.getByRole("link", { name: "Containing release v1.0.0", exact: true });
    await link.waitFor();
    assert.equal(await link.getAttribute("href"), "https://github.com/fictional/project/releases/tag/v1.0.0");
    await delivery.getByText("Verified release", { exact: true }).waitFor();
    await delivery.getByText(f.tip, { exact: true }).waitFor();
    await delivery.getByText("2026-10-14T12:00:00Z", { exact: true }).waitFor();
    assert(await delivery.evaluate(el => el.scrollWidth <= el.clientWidth), "Release evidence fits a phone");
    assert.equal(await delivery.getByRole("button", { name: "Save delivery links", exact: true }).count(), 0);
    await page.reload();
    await link.waitFor();
    const detail = await f.request(f.prefix).then(r => r.json());
    assert.equal(detail.implementation.delivery_scope.milestone, "release");
    assert.equal(detail.implementation.outcome, "released");
    assert.equal(detail.board.lane, "done");
    assert(f.calls().every(call => !call.args.includes("--method")), "Release observation sends no native mutations");
    assert.deepEqual(errors, []);
    console.log("Release delivery browser: passive Running wait, owner-action precedence, unavailable evidence, frozen policy and retained mobile release proof");
  } finally { await page.close(); await f.close(); }
}
