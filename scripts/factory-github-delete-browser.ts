import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import type { Browser } from "playwright-core";
import { githubFixture } from "./factory-github-fixture.ts";

export async function checkGitHubDelete(browser: Browser): Promise<void> {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const f = await githubFixture();
    const context = await browser.newContext({ viewport, isMobile: viewport.width < 640, hasTouch: viewport.width < 640 });
    try {
      const route = `/projects/${f.project.id}/github`;
      assert.equal((await f.post(route + "/configure", f.policy)).status, 200);
      assert.equal((await f.post(route + "/sync", {})).status, 200);
      const idea = (await f.get("")).implementations[0];
      const data = JSON.parse(readFileSync(f.state, "utf8")); data.permission = "WRITE";
      writeFileSync(f.state, JSON.stringify(data));
      assert.equal((await context.request.post(`${f.origin}/api/auth`, { data: { token: "github-test-owner" } })).status(), 204);
      const page = await context.newPage(); page.setDefaultTimeout(12000);
      const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
      await page.goto(`${f.origin}/#factory/${idea.id}`);
      const controls = page.getByRole("region", { name: "Assignment deletion", exact: true });
      await controls.getByRole("button", { name: "Delete Assignment", exact: true }).click();
      await controls.getByRole("button", { name: "Delete all owned work", exact: true }).click();
      await controls.getByText("Delete pending", { exact: true }).waitFor();
      await controls.getByText("Local cleanup is complete. Required external cleanup is still pending.", { exact: true }).waitFor();
      await controls.getByText(/GitHub.*repository-admin/).waitFor();
      await page.reload();
      await controls.getByText(/GitHub.*repository-admin/).waitFor();
      assert.equal((await f.get(route)).sources.length, 0);
      data.permission = "ADMIN"; writeFileSync(f.state, JSON.stringify(data));
      await page.waitForURL(url => !url.hash.includes(idea.id));
      assert.deepEqual((await f.get("")).implementations, []);
      assert.deepEqual(JSON.parse(readFileSync(f.state, "utf8")).issues, []);
      assert.deepEqual(errors, []);
    } finally { await context.close(); f.close(); }
  }
  console.log("PASS desktop/mobile GitHub Delete permission progress, reload and automatic completion");
}
