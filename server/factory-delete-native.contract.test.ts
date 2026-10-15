import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import { herdrRpc, workspaceClose, type WorkspaceCreateResult } from "./herdr/client.ts";
import { FactoryStore } from "./factory-store.ts";
import type { FactoryNative } from "./factory-native.ts";

async function fixture(overrides: Partial<FactoryNative> = {}) {
  const root = mkdtempSync(join(tmpdir(), "factory-delete-"));
  const repo = join(root, "repo"); mkdirSync(repo); writeFileSync(join(repo, "README.md"), "Protected primary checkout\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-b", "main"); git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "initial");
  const owned: string[] = []; const token = "owned-delete-fixture";
  const state = join(root, "state");
  const options = { port: 0, token, stateDir: state, machines: false as const, factory: { accountDiscoveryHome: root, native: {
    version: async () => "owned-delete-cli",
    createWorkspace: async (options: Parameters<FactoryNative["createWorkspace"]>[0]) => { const result = await herdrRpc<WorkspaceCreateResult>("workspace.create", { ...options, focus: false }); owned.push(result.workspace.workspace_id); return result; },
    startAgent: async (options: Parameters<FactoryNative["startAgent"]>[0]) => { await herdrRpc("pane.report_agent", { pane_id: options.paneId, source: "manual", agent: "codex", state: "idle" }); },
    ...overrides,
  } } };
  let app = createServer(options);
  const request = (path: string, body?: unknown) => fetch(`http://localhost:${app.port}${path}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-herdr-factory": "1", "x-herdr-machine": "1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const api = (path: string, body?: unknown) => request(`/api/factory${path}`, body);
  const project = await api("/projects", { name: "Shared protected Project", path: repo, machine_id: "local", provider: "codex", tracker: "app" }).then(r => r.json());
  const assignment = async (title: string) => api("/implementations", { title, description: "Owned fixture", project_id: project.id }).then(r => r.json());
  const readFile = (path: string) => request(`/api/fs/file?path=${encodeURIComponent(path)}`);
  return { root, repo, state, git, api, request, assignment, readFile, get app() { return app; }, project,
    restart: () => { app.stop(); app = createServer(options); },
    close: async () => { app.stop(); for (const id of owned) await workspaceClose(id).catch(() => {}); rmSync(root, { recursive: true, force: true }); } };
}

describe("permanent Delete of owned native/Machine resources", () => {
  it("blocks destruction when a recorded checkout now holds an unrelated branch", async () => {
    const f = await fixture();
    try {
      const id = (await f.assignment("Changed ownership")).id;
      const run = await f.api(`/implementations/${id}/runs`, { action: "work", idempotency_key: "changed" }).then(r => r.json());
      execFileSync("git", ["-C", run.worktree, "switch", "-c", "independent-branch"], { stdio: "ignore" });
      writeFileSync(join(run.worktree, "README.md"), "Keep changed ownership\n");
      const result = await f.api(`/implementations/${id}/delete`, {}).then(r => r.json());
      expect(result.condition).toBe("pending"); expect(result.reasons.join(" ")).toContain("registration");
      expect(await f.readFile(join(run.worktree, "README.md")).then(r => r.text())).toBe("Keep changed ownership\n");
      expect((await f.api(`/implementations/${id}/resume`, {})).status).toBe(409);
    } finally { await f.close(); }
  }, 60_000);
  it("deletes a failed attempt with durable proof that native allocation was never attempted", async () => {
    let version = 0;
    const f = await fixture({ version: async () => `owned-changing-version-${version++}` });
    try {
      const id = (await f.assignment("Failed before native allocation")).id;
      const run = await f.api(`/implementations/${id}/runs`, { action: "work", idempotency_key: "failed" }).then(r => r.json());
      expect(run.condition).toBe("failed"); expect(run.workspace_id).toBeNull();
      expect(await f.api(`/implementations/${id}/delete`, {}).then(r => r.json())).toEqual({ id, condition: "deleted" });
      expect(await f.readFile(join(f.repo, "README.md")).then(r => r.text())).toBe("Protected primary checkout\n");
    } finally { await f.close(); }
  }, 60_000);
  it("recovers a lost native shutdown acknowledgment across restart without deleting unrelated work", async () => {
    let loseClose = true;
    const f = await fixture({ closeWorkspace: async id => { const result = await workspaceClose(id); if (loseClose) { loseClose = false; throw new Error("Owned lost shutdown acknowledgment"); } return result; } });
    try {
      const id = (await f.assignment("Interrupted deletion")).id;
      const run = await f.api(`/implementations/${id}/runs`, { action: "work", idempotency_key: "owned" }).then(r => r.json());
      expect((await f.api(`/implementations/${id}/delete`, {}).then(r => r.json())).condition).toBe("pending");
      f.restart();
      const deadline = Date.now() + 8_000;
      let status = 200;
      while (Date.now() < deadline) { status = (await f.api(`/implementations/${id}`)).status; if (status === 404) break; await Bun.sleep(30); }
      expect(status).toBe(404);
      expect((await f.readFile(join(run.worktree, "README.md"))).status).toBe(404);
      expect(await f.readFile(join(f.repo, "README.md")).then(r => r.text())).toBe("Protected primary checkout\n");
    } finally { await f.close(); }
  }, 60_000);
  it("retains uncertain build ownership and dirty data instead of declaring Delete complete", async () => {
    const f = await fixture();
    try {
      const id = (await f.assignment("Uncertain build deletion")).id;
      const run = await f.api(`/implementations/${id}/runs`, { action: "work", idempotency_key: "build" }).then(r => r.json());
      const store = new FactoryStore(f.state);
      const check = { ...store.record(), run_id: run.id, worker_id: null, head: run.base, workspace_hash: "", commands: [], condition: "interrupted" };
      store.put("host_checks", check, run.id); store.put("checks", check, run.id); store.close();
      const result = await f.api(`/implementations/${id}/delete`, {}).then(r => r.json());
      expect(result.condition).toBe("pending"); expect(result.reasons.join(" ")).toContain("build");
      const continuation = await f.request(`/api/factory-host/runs/${run.id}/operations/resume-context`, { pause_id: "00000000-0000-4000-8000-000000000000", history: "A late Machine continuation" });
      expect((await continuation.json()).error.code).toBe("assignment_deleting");
      f.restart();
      expect((await f.api("").then(r => r.json())).capacity.builds.used).toBe(1);
      expect((await f.readFile(join(run.worktree, "README.md"))).status).toBe(200);
    } finally { await f.close(); }
  }, 60_000);
  it("preserves pushed branches and an independently referenced local branch while removing owned worktrees", async () => {
    const f = await fixture();
    try {
      const id = (await f.assignment("Preserve published and shared branches")).id;
      const first = await f.api(`/implementations/${id}/runs`, { action: "work", idempotency_key: "first" }).then(r => r.json());
      await f.api(`/runs/${first.id}/stop`, {});
      const independent = join(f.root, "independent-checkout");
      f.git("worktree", "add", "--force", independent, first.branch);
      writeFileSync(join(independent, "README.md"), "Independent work survives\n");
      const run = await f.api(`/implementations/${id}/runs`, { action: "work", idempotency_key: "published" }).then(r => r.json());
      const remote = join(f.root, "published.git");
      execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
      f.git("remote", "add", "origin", remote); f.git("push", "origin", run.branch);
      expect(await f.api(`/implementations/${id}/delete`, {}).then(r => r.json())).toEqual({ id, condition: "deleted" });
      expect((await f.readFile(join(first.worktree, "README.md"))).status).toBe(404);
      expect((await f.readFile(join(run.worktree, "README.md"))).status).toBe(404);
      expect(await f.readFile(join(independent, "README.md")).then(r => r.text())).toBe("Independent work survives\n");
      for (const branch of [first.branch, run.branch]) expect((await f.readFile(join(f.repo, ".git", "refs", "heads", branch))).status).toBe(200);
      expect((await f.readFile(join(remote, "refs", "heads", run.branch))).status).toBe(200);
    } finally { await f.close(); }
  }, 60_000);
  it("deletes a stopped attempt even when its clean checkout was already removed", async () => {
    const f = await fixture();
    try {
      const id = (await f.assignment("Already cleaned attempt")).id;
      const run = await f.api(`/implementations/${id}/runs`, { action: "work", idempotency_key: "cleaned" }).then(r => r.json());
      await f.api(`/runs/${run.id}/stop`, {});
      expect((await f.api(`/runs/${run.id}/cleanup`, {})).status).toBe(200);
      expect(await f.api(`/implementations/${id}/delete`, {}).then(r => r.json())).toEqual({ id, condition: "deleted" });
      expect((await f.readFile(join(f.repo, ".git", "refs", "heads", run.branch))).status).toBe(404);
    } finally { await f.close(); }
  }, 60_000);
  it("removes dirty and ignored work across every attempt while preserving primary and sibling work", async () => {
    const f = await fixture();
    try {
      const id = (await f.assignment("Remove all owned work")).id;
      const first = await f.api(`/implementations/${id}/runs`, { action: "work", idempotency_key: "first" }).then(r => r.json());
      await f.api(`/runs/${first.id}/stop`, {});
      const run = await f.api(`/implementations/${id}/runs`, { action: "work", idempotency_key: "second" }).then(r => r.json());
      const worker = await f.api(`/runs/${run.id}/workers`, { role: "standards", idempotency_key: "child" }).then(r => r.json());
      for (const path of [first.worktree, run.worktree, worker.worktree]) {
        writeFileSync(join(path, "README.md"), "Delete unfinished changes\n");
        writeFileSync(join(path, ".gitignore"), "ignored.txt\n");
        writeFileSync(join(path, "ignored.txt"), "Delete ignored output\n");
      }
      const sibling = await f.assignment("Keep sibling");
      const keep = await f.api(`/implementations/${sibling.id}/runs`, { action: "work", idempotency_key: "keep" }).then(r => r.json());
      const response = await f.api(`/implementations/${id}/delete`, {});
      expect(await response.json()).toEqual({ id, condition: "deleted" });
      for (const path of [first.worktree, run.worktree, worker.worktree]) expect((await f.readFile(join(path, "README.md"))).status).toBe(404);
      for (const branch of [first.branch, run.branch, worker.branch]) expect((await f.readFile(join(f.repo, ".git", "refs", "heads", branch))).status).toBe(404);
      expect(await f.readFile(join(f.repo, "README.md")).then(r => r.text())).toBe("Protected primary checkout\n");
      expect(await f.readFile(join(keep.worktree, "README.md")).then(r => r.text())).toBe("Protected primary checkout\n");
      const native = await f.request("/api/session").then(r => r.json());
      expect(native.snapshot.panes.some((p: any) => p.pane_id === keep.pane_id)).toBe(true);
      expect(native.snapshot.panes.some((p: any) => [run.pane_id, worker.pane_id].includes(p.pane_id))).toBe(false);
      expect((await f.api("").then(r => r.json())).projects.map((p: any) => p.id)).toContain(f.project.id);
    } finally { await f.close(); }
  }, 60_000);
});
