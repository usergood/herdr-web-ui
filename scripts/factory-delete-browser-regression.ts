/** Delete controls and truthful progress through the real desktop/mobile client. */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { chromium, type Browser } from "playwright-core";
import { capacityFixture } from "./factory-capacity-fixture.ts";
import { checkGitHubDelete } from "./factory-github-delete-browser.ts";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { execFileSync, spawnSync } from "node:child_process";
import { publishedDeleteFixture } from "../server/factory-published-delete.fixture.ts";
import { until } from "./factory-human-review-fixture.ts";

/** Public publication and Delete preserve pushed refs without any tracking marker. */
export async function publishedBranchDeleteJourney(browser: Browser, viewport: { width: number; height: number }, unknownPush: boolean) {
  const f = await publishedDeleteFixture();
  const context = await browser.newContext({ viewport, isMobile: viewport.width < 640, hasTouch: viewport.width < 640 });
  let locked = false;
  try {
    const response = await f.publish(unknownPush ? "push-unknown" : "confirmed"); const publication = await response.json();
    console.log(JSON.stringify({ viewport: viewport.width, unknown_push: unknownPush, publication_status: response.status, publication }));
    assert.equal(response.status, 200); assert.equal(publication.condition, unknownPush ? "uncertain" : "confirmed");
    const branch = f.run.branch!; const head = f.head;
    const bareRef = () => execFileSync("git", ["--git-dir", f.bare, "rev-parse", `refs/heads/${branch}`], { encoding: "utf8" }).trim();
    assert.equal(bareRef(), head); assert.equal(f.git(["rev-parse", `refs/heads/${branch}`]).trim(), head);
    assert.equal(f.git(["for-each-ref", "--format=%(refname)", "refs/remotes/"]).trim(), "");
    assert.equal(spawnSync("git", ["-C", f.repo, "config", "--get-regexp", "^branch\\."], { encoding: "utf8" }).status, 1);
    assert.deepEqual(f.transportCalls(), [["-C", f.run.worktree!, "-c", "push.followTags=false", "push", "--", "https://github.com/fictional/project.git", `${head}:refs/heads/${branch}`]]);
    assert.equal((await f.request(`/runs/${f.run.id}/stop`, {})).status, 200);
    await f.start("local-only-control");
    const detail = () => f.request(f.prefix).then(response => response.json());
    const staged = await until(detail, d => d.runs.some((run: any) => run.idempotency_key === "local-only-control" && run.worktree && run.pane_id));
    const local = staged.runs.find((run: any) => run.idempotency_key === "local-only-control");
    assert.notEqual(local.branch, branch); assert.equal(f.git(["rev-parse", `refs/heads/${local.branch}`]).trim().length, 40);
    const primary = join(f.repo, "README.md"); const primaryContent = "Protected primary dirty work\n";
    writeFileSync(primary, primaryContent);
    const unrelated = join(f.root, "independent-worktree"); const unrelatedBranch = "owned-independent-work";
    f.git(["worktree", "add", "-b", unrelatedBranch, unrelated, "main"]);
    writeFileSync(join(unrelated, "README.md"), "Protected unrelated dirty work\n");
    const unrelatedHead = f.git(["rev-parse", unrelatedBranch]).trim();
    for (const path of [f.run.worktree!, local.worktree]) {
      writeFileSync(join(path, "README.md"), "Delete owned dirty work\n");
      writeFileSync(join(path, ".gitignore"), "ignored-owned.txt\n"); writeFileSync(join(path, "ignored-owned.txt"), "Delete owned ignored work\n");
    }
    f.git(["worktree", "lock", f.run.worktree!]); locked = true;
    const id = f.prefix.split("/").at(-1)!; const origin = () => `http://localhost:${f.app.port}`;
    assert.equal((await context.request.post(`${origin()}/api/auth`, { data: { token: f.token } })).status(), 204);
    let page = await context.newPage(); page.setDefaultTimeout(12000);
    const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${origin()}/#factory/${id}`);
    const controls = page.getByRole("region", { name: "Assignment deletion", exact: true });
    await controls.getByRole("button", { name: "Delete Assignment", exact: true }).click();
    const deleting = page.waitForResponse(response => response.url().endsWith(`${f.prefix}/delete`) && response.request().method() === "POST");
    await controls.getByRole("button", { name: "Delete all owned work", exact: true }).click();
    const deletedResponse = await deleting; const pending = await deletedResponse.json(); assert.equal(deletedResponse.status(), 202); assert.equal(pending.condition, "pending");
    await controls.getByText("Delete pending", { exact: true }).waitFor();
    assert(existsSync(f.run.worktree!)); assert.equal((await f.request(f.prefix)).status, 200);
    await page.reload(); await controls.getByText("Delete pending", { exact: true }).waitFor();
    await page.close(); f.restart();
    assert.equal((await context.request.post(`${origin()}/api/auth`, { data: { token: f.token } })).status(), 204);
    page = await context.newPage(); page.setDefaultTimeout(12000); page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${origin()}/#factory/${id}`);
    await page.getByRole("region", { name: "Assignment deletion", exact: true }).getByText("Delete pending", { exact: true }).waitFor();
    f.git(["worktree", "unlock", f.run.worktree!]); locked = false;
    const settled = await f.request(f.prefix + "/delete", {}); assert.equal(settled.status, 200);
    await page.waitForURL(url => !url.hash.includes(id));
    assert.equal((await f.request(f.prefix)).status, 404);
    const overview = await f.request("").then(response => response.json()); assert(!overview.implementations.some((entry: any) => entry.id === id));
    const refs = f.git(["for-each-ref", "--format=%(refname) %(objectname)", `refs/heads/${branch}`, `refs/heads/${local.branch}`, `refs/heads/${unrelatedBranch}`]).trim();
    console.log(JSON.stringify({ viewport: viewport.width, unknown_push: unknownPush, after_delete: { assignment_status: 404, refs, remote_head: bareRef(), published_worktree_exists: existsSync(f.run.worktree!), local_only_worktree_exists: existsSync(local.worktree), transport_calls: f.transportCalls() } }));
    assert.equal(f.git(["for-each-ref", "--format=%(objectname)", `refs/heads/${branch}`]).trim(), head, "Delete must preserve the published local branch even without remote tracking metadata");
    assert.equal(f.git(["for-each-ref", "--format=%(objectname)", `refs/heads/${local.branch}`]).trim(), "");
    assert.equal(bareRef(), head); assert.equal(existsSync(f.run.worktree!), false); assert.equal(existsSync(local.worktree), false);
    assert.equal(readFileSync(primary, "utf8"), primaryContent); assert.equal(readFileSync(join(unrelated, "README.md"), "utf8"), "Protected unrelated dirty work\n"); assert.equal(f.git(["rev-parse", unrelatedBranch]).trim(), unrelatedHead);
    assert.equal(f.transportCalls().length, 1); assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); assert.deepEqual(errors, []);
    console.log(`PASS actual ${unknownPush ? "uncertain" : "confirmed"} URL publication survives desktop/mobile Delete, pending restart and owned local-only cleanup (${viewport.width})`);
  } finally { if (locked) f.git(["worktree", "unlock", f.run.worktree!]); await context.close(); await f.close(); }
}

if (import.meta.main) {
const browser = await chromium.launch({ executablePath: process.env["CHROME_PATH"] || chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
try {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    const f = await capacityFixture();
    const context = await browser.newContext({ viewport, isMobile: viewport.width < 640, hasTouch: viewport.width < 640 });
    try {
      await f.api("/settings", { max_agents: 1 });
      const id = await f.assignment("Failed unfinished work to delete");
      const failed = await f.api(`/implementations/${id}/runs`, { action: "work", idempotency_key: "active" }).then(r => r.json());
      f.runs.get(failed.id)!.condition = "failed";
      await f.api(`/runs/${failed.id}/reconcile`, {});
      const holderId = await f.assignment("Unrelated capacity holder");
      const holder = await f.api(`/implementations/${holderId}/runs`, { action: "work", idempotency_key: "holder" }).then(r => r.json());
      const backup = await f.api("/backups", {}).then(r => r.json());
      const obstacle = join(f.state, "factory", "backups", backup.id, "manifest.json.tmp");
      mkdirSync(obstacle);
      assert.equal((await f.api("").then(r => r.json())).capacity.normal.used, 1);
      const origin = `http://localhost:${f.app.port}`;
      assert.equal((await context.request.post(`${origin}/api/auth`, { data: { token: f.token } })).status(), 204);
      const page = await context.newPage(); page.setDefaultTimeout(12_000);
      const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
      await page.goto(`${origin}/#factory/${id}`);
      const controls = page.getByRole("region", { name: "Assignment deletion", exact: true });
      await controls.getByRole("button", { name: "Delete Assignment", exact: true }).click();
      await controls.getByText(/Exported copies and external provider history/).waitFor();
      f.offline(true);
      await controls.getByRole("button", { name: "Delete all owned work", exact: true }).click();
      await controls.getByText("Delete pending", { exact: true }).waitFor();
      await controls.getByText(/owned-a/).waitFor();
      await page.reload();
      await controls.getByText("Delete pending", { exact: true }).waitFor();
      assert.equal(await page.getByRole("button", { name: "Resume Assignment", exact: true }).count(), 0);
      f.offline(false);
      await controls.getByText(/backup.*rewrite destination/).waitFor();
      assert.equal((await f.api(`/implementations/${id}`)).status, 200);
      await page.reload();
      await controls.getByText("Delete pending", { exact: true }).waitFor();
      await controls.getByText(/backup.*rewrite destination/).waitFor();
      rmSync(obstacle, { recursive: true });
      await page.waitForURL(url => !url.hash.includes(id));
      await page.getByText("Failed unfinished work to delete", { exact: true }).waitFor({ state: "hidden" });
      assert.equal((await f.api(`/implementations/${id}`)).status, 404);
      assert.equal((await f.api(`/backups/${backup.id}/restore`, {})).status, 201);
      await f.api(`/runs/${holder.id}/stop`, {});
      for (const condition of ["stopped", "paused", "finished", "unfinished"]) {
        const target = await f.assignment(`Delete ${condition} work`);
        if (condition !== "unfinished") {
          const run = await f.api(`/implementations/${target}/runs`, { action: "work", idempotency_key: condition }).then(r => r.json());
          if (condition === "paused") await f.api(`/implementations/${target}/pause`, {});
          else if (condition === "finished") {
            const native = f.runs.get(run.id)!;
            native.workspace_id = `owned-finished-${run.id}`; native.pane_id = `${native.workspace_id}:p1`;
            f.researchReady(run.id);
            assert.equal((await f.api(`/runs/${run.id}/reconcile`, {})).status, 200);
            assert.equal((await f.api(`/implementations/${target}/complete-work`, { run_id: run.id })).status, 200);
          }
          else await f.api(`/runs/${run.id}/stop`, {});
        }
        const before = await f.api(`/implementations/${target}`).then(r => r.json());
        if (condition === "finished") assert.equal(before.implementation.stage, "done");
        if (condition === "paused") assert.equal(before.implementation.pause.condition, "paused");
        if (condition === "stopped") assert.equal(before.runs[0].condition, "cancelled");
        await page.goto(`${origin}/#factory/${target}`);
        await controls.getByRole("button", { name: "Delete Assignment", exact: true }).click();
        await controls.getByRole("button", { name: "Cancel", exact: true }).click();
        assert.equal((await f.api(`/implementations/${target}`)).status, 200);
        await controls.getByRole("button", { name: "Delete Assignment", exact: true }).click();
        await controls.getByRole("button", { name: "Delete all owned work", exact: true }).click();
        await page.waitForURL(url => !url.hash.includes(target));
        assert.equal((await f.api(`/implementations/${target}`)).status, 404);
      }
      assert.deepEqual(errors, []);
    } finally { await context.close(); f.close(); }
  }
  console.log("PASS desktop/mobile Delete control, Machine/backup pending reasons, interrupted rewrite, reload, recovery and final removal");
  await checkGitHubDelete(browser);
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) for (const unknownPush of [false, true]) await publishedBranchDeleteJourney(browser, viewport, unknownPush);
} finally { await browser.close(); }
}
