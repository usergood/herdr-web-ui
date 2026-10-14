/** Confirmed browser seam: owned plan and GitHub effects behind the real API. */
import "./test-herdr.ts";
import assert from "node:assert/strict";
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
  assert.deepEqual(errors, []);
  console.log("Issue batch browser: whole-plan review, explicit publication, retained issue links, keyboard and phone layout passed");
} catch (error) { console.error({ url: page?.url(), errors, text: (await page?.locator("body").innerText())?.slice(-6000) }); throw error; }
finally { await browser.close(); f.close(); }
