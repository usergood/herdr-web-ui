import { expect, it } from "bun:test";
import { execFileSync } from "node:child_process";

// An isolated process supplies the OS boundary only after ordinary owned host
// admission. This proves HTTP refusal on Linux; it is not Windows certification.
it("refuses uncertified Windows host builds before executing commands or retaining check ownership", () => {
  const script = String.raw`
    import { execFileSync } from "node:child_process";
    import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
    import { tmpdir } from "node:os";
    import { join } from "node:path";
    import { createServer } from ${JSON.stringify(new URL("./index.ts", import.meta.url).pathname)};
    const root = mkdtempSync(join(tmpdir(), "factory-windows-admission-"));
    const repo = join(root, "repo"); mkdirSync(repo);
    writeFileSync(join(repo, "README.md"), "Owned platform fixture\n");
    for (const args of [["init", "-b", "main"], ["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "initial"]]) execFileSync("git", args, { cwd: repo, stdio: "ignore" });
    const marker = join(root, "unexpected-command");
    const panes = []; const workspaces = [];
    const app = createServer({ port: 0, token: "owned-platform-host", stateDir: join(root, "state"), machines: false, factory: { accountDiscoveryHome: root, native: {
      version: async () => "owned-platform-fixture",
      createWorkspace: async options => { const workspace = { workspace_id: crypto.randomUUID(), label: options.label }; const pane = { pane_id: workspace.workspace_id + ":p1", workspace_id: workspace.workspace_id, terminal_id: workspace.workspace_id + ":terminal", cwd: options.cwd, agent: "codex", agent_status: "idle" }; workspaces.push(workspace); panes.push(pane); return { workspace, root_pane: pane }; },
      startAgent: async () => ({}), snapshot: async () => ({ panes, workspaces }),
      closeWorkspace: async id => { for (let i = panes.length - 1; i >= 0; i--) if (panes[i].workspace_id === id) panes.splice(i, 1); const index = workspaces.findIndex(w => w.workspace_id === id); if (index >= 0) workspaces.splice(index, 1); return {}; },
    } } });
    const api = (path, body) => fetch("http://localhost:" + app.port + "/api/" + path, { method: body === undefined ? "GET" : "POST", headers: { authorization: "Bearer owned-platform-host", "content-type": "application/json", "x-herdr-factory": "1", "x-herdr-machine": "1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    try {
      const checkout = await api("factory-host/inspect", { path: repo }).then(r => r.json());
      const capabilities = await api("factory/providers").then(r => r.json());
      const now = new Date().toISOString(); const id = crypto.randomUUID();
      const record = { id, created_at: now, updated_at: now, implementation_id: crypto.randomUUID(), action: "work", provider: "codex", machine_id: "owned-remote-host", condition: "accepted", waiting_reason: null, idempotency_key: "owned-platform", specification_id: null, graph_hash: null, base: checkout.head, checkout: repo, worktree: null, branch: null, workspace_id: null, pane_id: null, manifest: { skills: { hash: capabilities.skill_manifest.hash }, provider_version: "owned-platform-fixture", checkout, project: { permission_mode: "approve_for_me", checks: [[process.execPath, "-e", "require('node:fs').writeFileSync(" + JSON.stringify(marker) + ", 'must not execute')"]] }, implementation: { title: "Owned Windows build refusal", description: "No certified tree ownership" } } };
      const launched = await api("factory-host/launch", { run: record });
      if (launched.status !== 202) throw new Error("Owned host admission failed: " + await launched.text());
      const check = { id: crypto.randomUUID(), created_at: now, updated_at: now, run_id: id, worker_id: null, head: "", workspace_hash: "", commands: [], condition: "working" };
      Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
      const response = await api("factory-host/runs/" + id + "/operations/check", { check });
      const body = await response.json();
      Object.defineProperty(process, "platform", platform);
      const retained = await api("factory-host/runs/" + id + "/operations/check-reconcile", { check_id: check.id });
      const pause = await api("factory-host/runs/" + id + "/operations/pause", { pause_id: crypto.randomUUID() });
      const paused = await pause.json();
      console.log("OWNED_WINDOWS_RESULT=" + JSON.stringify({ status: response.status, body, executed: existsSync(marker), retained: retained.status, pause: { status: pause.status, checks: paused.checks, run: paused.run?.suspension } }));
    } finally { Object.defineProperty(process, "platform", platform); app.stop(); rmSync(root, { recursive: true, force: true }); }
  `;
  const output = execFileSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
  const line = output.split("\n").find(line => line.startsWith("OWNED_WINDOWS_RESULT="));
  expect(line).toBeDefined();
  const result = JSON.parse(line!.slice("OWNED_WINDOWS_RESULT=".length));
  expect(result.status, JSON.stringify(result)).toBe(409);
  expect(result.body).toMatchObject({ error: { code: "build_contract_unverified" } });
  expect(result.executed).toBe(false);
  expect(result.retained).toBe(404);
  expect(result.pause).toMatchObject({ status: 200, checks: [], run: { condition: "stopped" } });
}, 40_000);
