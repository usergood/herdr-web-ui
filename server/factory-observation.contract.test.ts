import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import type { FactoryNative } from "./factory-native.ts";
import type { FactoryRun } from "../shared/protocol.ts";

/** Real execution host and Git leases, with only the native process transport replaced. */
async function observationFixture() {
  const root = mkdtempSync(join(tmpdir(), "owned-observation-"));
  const repo = join(root, "repo");
  const git = (path: string, args: string[]) => execFileSync("git", ["-C", path, ...args], { stdio: "pipe" }).toString().trim();
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
  writeFileSync(join(repo, "README.md"), "Owned fictional repository\n");
  git(repo, ["add", "."]); git(repo, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture"]);
  let snapshot: Awaited<ReturnType<FactoryNative["snapshot"]>> = { workspaces: [], panes: [], agents: [] } as unknown as Awaited<ReturnType<FactoryNative["snapshot"]>>;
  let offline = false; let nativeStarts = 0;
  const native: Partial<FactoryNative> = {
    version: async () => "owned-native-version",
    createWorkspace: async options => {
      const workspace = { workspace_id: "owned-workspace", label: options?.label };
      const pane = { pane_id: "owned-workspace:p1", workspace_id: workspace.workspace_id, cwd: options?.cwd, agent: "codex", agent_status: "idle" };
      snapshot = { ...snapshot, workspaces: [workspace], panes: [pane] } as typeof snapshot;
      return { workspace, root_pane: pane } as Awaited<ReturnType<FactoryNative["createWorkspace"]>>;
    },
    startAgent: async () => { nativeStarts++; return {} as Awaited<ReturnType<FactoryNative["startAgent"]>>; },
    snapshot: async () => { if (offline) throw new Error("Owned snapshot unavailable"); return snapshot; },
    closeWorkspace: async () => { snapshot = { ...snapshot, workspaces: [], panes: [] }; },
  };
  const options = { port: 0, stateDir: join(root, "state"), machines: false as const, token: "owned-observation", factory: { skillsPath: join(import.meta.dir, "../vendor/matt-skills"), accountDiscoveryHome: root, native } };
  let app = createServer(options);
  const request = (path: string, body?: unknown) => fetch(`http://localhost:${app.port}/api/factory-host${path}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: "Bearer owned-observation", "x-herdr-factory": "1", "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const checkout = await request("/inspect", { path: repo }).then(r => r.json());
  const capabilities = await request("/capabilities").then(r => r.json());
  const id = randomUUID();
  const run: FactoryRun = await request("/launch", { run: { id, implementation_id: randomUUID(), action: "work", provider: "codex", machine_id: "local", condition: "accepted", base: checkout.head, checkout: repo, manifest: { skills: capabilities.skill_manifest, checkout, provider_version: "owned-native-version", implementation: { title: "Owned work", description: "Fictional scope" }, project: { checks: [[process.execPath, "--version"]] } } } }).then(r => r.json());
  expect(run.condition).toBe("working");
  return { request, run, git, setOffline(value: boolean) { offline = value; }, get nativeStarts() { return nativeStarts; }, restart() { app.stop(); app = createServer(options); }, close() { app.stop(); rmSync(root, { recursive: true, force: true }); } };
}

test("the execution host observes the exact checkout after closing its native lease without reopening mutations", async () => {
  const fixture = await observationFixture();
  try {
    const { run, request } = fixture;
    const before = await request(`/runs/${run.id}/operations/head`, {}).then(r => r.json());
    expect(before.head).toBe(run.base);
    expect((await request(`/runs/${run.id}/stop`, {})).status).toBe(200);
    const observed = await request(`/runs/${run.id}/operations/head`, {});
    expect(observed.status).toBe(200);
    expect(await observed.json()).toEqual(before);
    fixture.restart();
    expect(await request(`/runs/${run.id}/operations/head`, {}).then(r => r.json())).toEqual(before);
    const worker = { id: randomUUID(), run_id: run.id, role: "implementer", base: run.base };
    for (const [operation, body] of [["worker", { worker }], ["check", { check: { id: randomUUID(), run_id: run.id } }], ["refresh", { worker_id: worker.id }], ["integrate", { worker_id: worker.id, tip: run.base }]] as const) {
      const denied = await request(`/runs/${run.id}/operations/${operation}`, body);
      expect(denied.status).toBe(409); expect((await denied.json()).error.code).toBe("run_stopping");
    }
    expect((await request(`/runs/${run.id}/send`, { text: "Do not send" })).status).toBe(409);
    expect(fixture.nativeStarts).toBe(1);
    expect((await request(`/runs/${randomUUID()}/operations/head`, {})).status).toBe(409);
  } finally { fixture.close(); }
}, 15_000);

test.each(["branch", "repository", "cwd"])("stopped checkout observation rejects a changed %s", async kind => {
  const fixture = await observationFixture();
  try {
    const { run, request, git } = fixture;
    await request(`/runs/${run.id}/stop`, {});
    if (kind === "branch") git(run.worktree!, ["branch", "-m", "unowned-branch"]);
    if (kind === "repository") {
      git(run.worktree!, ["checkout", "--orphan", "unrelated-history"]);
      git(run.worktree!, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Unrelated repository root"]);
      git(run.worktree!, ["branch", "-M", run.branch!]);
    }
    if (kind === "cwd") { renameSync(run.worktree!, run.worktree! + "-moved"); symlinkSync(run.worktree! + "-moved", run.worktree!); }
    const response = await request(`/runs/${run.id}/operations/head`, {});
    expect(response.status).toBe(409); expect((await response.json()).error.code).toBe("worktree_changed");
  } finally { fixture.close(); }
}, 15_000);

test("stopped checkout observation reads current committed and uncommitted changes", async () => {
  const fixture = await observationFixture();
  try {
    const { run, request, git } = fixture;
    const before = await request(`/runs/${run.id}/operations/head`, {}).then(r => r.json());
    await request(`/runs/${run.id}/stop`, {});
    writeFileSync(join(run.worktree!, "README.md"), "Changed after the reviewed turn\n");
    const changed = await request(`/runs/${run.id}/operations/head`, {}).then(r => r.json());
    expect(changed.head).toBe(before.head); expect(changed.workspace_hash).not.toBe(before.workspace_hash);
    git(run.worktree!, ["add", "README.md"]);
    git(run.worktree!, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Later change"]);
    const committed = await request(`/runs/${run.id}/operations/head`, {}).then(r => r.json());
    expect(committed.head).not.toBe(before.head); expect(committed.workspace_hash).toBe(before.workspace_hash);
  } finally { fixture.close(); }
}, 15_000);

test("checkout observation cannot turn an uncertain native stop into permission to mutate", async () => {
  const fixture = await observationFixture();
  try {
    const { run, request } = fixture;
    const before = await request(`/runs/${run.id}/operations/head`, {}).then(r => r.json());
    fixture.setOffline(true);
    expect((await request(`/runs/${run.id}/stop`, {})).status).toBe(500);
    fixture.restart();
    expect(await request(`/runs/${run.id}/operations/head`, {}).then(r => r.json())).toEqual(before);
    expect(await request(`/runs/${run.id}/reconcile`, {}).then(r => r.json())).toMatchObject({ condition: "disconnected" });
    const denied = await request(`/runs/${run.id}/operations/worker`, { worker: { id: randomUUID(), run_id: run.id, role: "implementer" } });
    expect(denied.status).toBe(409); expect((await denied.json()).error.code).toBe("run_stopping");
    expect((await request(`/runs/${run.id}/operations/cleanup`, {})).status).toBe(409);
    fixture.setOffline(false);
    expect(await request(`/runs/${run.id}/stop`, {}).then(r => r.json())).toMatchObject({ condition: "cancelled" });
    expect(await request(`/runs/${run.id}/operations/head`, {}).then(r => r.json())).toEqual(before);
    expect(fixture.nativeStarts).toBe(1);
  } finally { fixture.close(); }
}, 15_000);

test("a verified removed host checkout cannot be observed as a live checkout", async () => {
  const fixture = await observationFixture();
  try {
    const { run, request } = fixture;
    await request(`/runs/${run.id}/stop`, {});
    expect(await request(`/runs/${run.id}/operations/cleanup`, {}).then(r => r.json())).toMatchObject({ removed: [run.worktree], branches_retained: true, notes_retained: true });
    expect((await request(`/runs/${run.id}/operations/head`, {})).ok).toBe(false);
  } finally { fixture.close(); }
}, 15_000);
