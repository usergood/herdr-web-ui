/** Confirmed browser seam: owned plan and GitHub effects behind the real API. */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { chromium, type Page } from "playwright-core";
import { batchProposal, githubIssueBatchFixture } from "../server/github-issue-batches.fixture.ts";

const f = await githubIssueBatchFixture();
assert.equal((await f.request(f.githubRoute + "/configure", f.policy)).status, 200);
const draft = (await f.request(f.route, batchProposal)).body;
const browser = await chromium.launch({ executablePath: process.env["CHROME_PATH"] || chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
let page: Page | undefined;
const errors: string[] = [];
try {
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }); page.setDefaultTimeout(10000);
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(f.origin() + `/#factory/${f.assignment.id}`);
  const batch = page.getByRole("region", { name: "Independent improvements", exact: true });
  await batch.getByRole("heading", { name: "Keep owner notes", exact: true }).waitFor();
  await batch.getByText("The owner's notes survive repeated imports.", { exact: true }).waitFor();
  await batch.getByText("One Assignment and delivery PR for history access", { exact: true }).waitFor();
  assert.equal(await batch.getByRole("button", { name: "Publish issue batch", exact: true }).isDisabled(), true);
  assert.equal(f.calls().filter(args => args.includes("POST") || args.includes("PATCH")).length, 0);
  await batch.getByRole("button", { name: "Review issue batch", exact: true }).focus(); await page.keyboard.press("Enter");
  await batch.getByText("Reviewed", { exact: true }).waitFor();
  assert.equal(f.calls().filter(args => args.includes("POST") || args.includes("PATCH")).length, 0);
  assert.equal(await batch.getByRole("button", { name: "Publish issue batch", exact: true }).isEnabled(), true);
  for (const width of [390, 320]) {
    const phone = await browser.newPage({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true }); phone.setDefaultTimeout(10000);
    await phone.goto(f.origin() + `/#factory/${f.assignment.id}`);
    const phoneBatch = phone.getByRole("region", { name: "Independent improvements", exact: true });
    await phoneBatch.getByText("Reviewed", { exact: true }).waitFor();
    assert.equal(await phoneBatch.evaluate(element => element.scrollWidth <= element.clientWidth + 1), true);
    const button = await phoneBatch.getByRole("button", { name: "Publish issue batch", exact: true }).boundingBox();
    assert.ok(button && button.width >= 44 && button.height >= 40);
    await phone.close();
  }
  const published = page.waitForResponse(response => response.url().endsWith(`/${draft.id}/publish`));
  await batch.getByRole("button", { name: "Publish issue batch", exact: true }).click(); assert.equal((await published).status(), 200);
  await batch.getByText("Published", { exact: true }).waitFor();
  await batch.getByRole("link", { name: "#101 · Keep owner notes", exact: true }).waitFor();
  await batch.getByRole("link", { name: "#102 · Show retained history", exact: true }).waitFor();
  assert.equal((await f.request(f.githubRoute)).body.sources.length, 2);
  await page.reload(); await batch.getByText("Published", { exact: true }).waitFor();

  const recovery = (await f.request(f.route, { ...batchProposal, title: "Recover interrupted improvements", idempotency_key: "owned-recovery-v1" })).body;
  const remote = JSON.parse(readFileSync(f.responses, "utf8")); remote.lose_create_receipt_number = 104;
  writeFileSync(f.responses, JSON.stringify(remote));
  await page.reload();
  const recovering = page.getByRole("region", { name: "Recover interrupted improvements", exact: true });
  await recovering.getByRole("button", { name: "Review issue batch", exact: true }).click();
  await recovering.getByText("Reviewed", { exact: true }).waitFor();
  await recovering.getByRole("button", { name: "Publish issue batch", exact: true }).click();
  await recovering.getByText("Publication held", { exact: true }).waitFor();
  await page.goto("about:blank");
  f.restart();
  await page.goto(f.origin() + `/#factory/${f.assignment.id}`);
  await recovering.getByText("Publication held", { exact: true }).waitFor();
  await recovering.getByText("Issues confirmed: 1/2", { exact: true }).waitFor();
  await recovering.getByText("Dependency links confirmed: 0/2", { exact: true }).waitFor();
  await recovering.getByRole("link", { name: "#103 · Keep owner notes", exact: true }).waitFor();
  await recovering.getByText("Resume checks GitHub for the same batch before continuing publication.", { exact: true }).waitFor();
  await recovering.getByText("Publication receipts", { exact: true }).click();
  await recovering.getByText(/Show retained history · Create issue · Uncertain/).waitFor();
  for (const width of [390, 320]) {
    const phone = await browser.newPage({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true }); phone.setDefaultTimeout(10000);
    await phone.goto(f.origin() + `/#factory/${f.assignment.id}`);
    const phoneBatch = phone.getByRole("region", { name: "Recover interrupted improvements", exact: true });
    const resume = phoneBatch.getByRole("button", { name: "Resume issue batch", exact: true });
    await resume.waitFor(); assert.equal(await resume.isEnabled(), true);
    assert.equal(await phoneBatch.evaluate(element => element.scrollWidth <= element.clientWidth + 1), true);
    const button = await resume.boundingBox(); assert.ok(button && button.width >= 44 && button.height >= 40);
    await phone.close();
  }
  const resumed = page.waitForResponse(response => response.url().endsWith(`/${recovery.id}/resume`));
  await recovering.getByRole("button", { name: "Resume issue batch", exact: true }).focus(); await page.keyboard.press("Enter");
  assert.equal((await resumed).status(), 200);
  await recovering.getByText("Published", { exact: true }).waitFor();
  await recovering.getByText("Issues confirmed: 2/2", { exact: true }).waitFor();
  await recovering.getByText("Dependency links confirmed: 2/2", { exact: true }).waitFor();
  await recovering.getByRole("link", { name: "#104 · Show retained history", exact: true }).waitFor();
  assert.equal(f.calls().filter(args => args.includes("POST")).length, 4);
  assert.equal((await f.request(f.githubRoute)).body.sources.length, 4);
  await page.reload(); await recovering.getByText("Published", { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log("Issue batch browser: whole-plan review, publication, restart and lost-receipt recovery, progress, retained links, keyboard and phone layout passed");
} catch (error) { console.error({ url: page?.url(), errors, text: (await page?.locator("body").innerText())?.slice(-6000) }); throw error; }
finally { await browser.close(); f.close(); }
