import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import { githubScheduleFixture } from "./github-schedules.fixture.ts";
import { factoryDeliveryFixture } from "./factory-delivery.fixture.ts";
import { batchProposal, githubIssueBatchFixture } from "./github-issue-batches.fixture.ts";
import { herdrRpc, sessionSnapshot, workspaceClose, workspaceCreate } from "./herdr/client.ts";

describe("Project queue through the public API", () => {
  it("holds every issue from an incomplete publication batch across restart", async () => {
    const f = await githubIssueBatchFixture();
    try {
      writeFileSync(f.responses, JSON.stringify({ fail_label_number: 102 }));
      const policy = (await f.request(f.githubRoute + "/configure", { ...f.policy, auto_implement: true })).body;
      const batch = (await f.request(f.route, batchProposal)).body;
      const proof = { revision: batch.revision, policy_revision: policy.revision };
      await f.request(`${f.route}/${batch.id}/review`, proof);
      expect((await f.request(`${f.route}/${batch.id}/publish`, proof)).body.condition).toBe("held");
      const source = (await f.request(f.githubRoute)).body.sources.find((source: { number: number }) => source.number === 101);
      const route = f.githubRoute.replace(/\/github$/, "/queue");
      const inspect = () => f.request(route);
      let queue = (await inspect()).body;
      expect(queue.next_implementation_id).toBeNull();
      expect(queue.items.find((item: { implementation_id: string }) => item.implementation_id === source.implementation_id).reasons).toContain("batch_incomplete");
      f.restart(); queue = (await inspect()).body;
      expect(queue.next_implementation_id).toBeNull();
      expect(queue.items.find((item: { implementation_id: string }) => item.implementation_id === source.implementation_id).reasons).toContain("batch_incomplete");
    } finally { f.close(); }
  });
  it("releases verified implementation capacity while holding the Assignment for delivery", async () => {
    const f = await factoryDeliveryFixture(true, true);
    try {
      await f.request(`/projects/${f.project.id}/configure`, { checks: [["git", "status", "--porcelain"]] });
      const run = await f.start();
      writeFileSync(join(run.worktree!, "queue-delivery.md"), "Reviewed queue fixture change\n");
      f.git(["add", "queue-delivery.md"], run.worktree!);
      f.git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "queue delivery"], run.worktree!);
      const head = f.git(["rev-parse", "HEAD"], run.worktree!).trim(); f.setReviewHead(head);
      await f.request(`/runs/${run.id}/checks`, {});
      for (const role of ["standards", "spec"]) {
        const worker = await f.request(`/runs/${run.id}/workers`, { role, idempotency_key: `queue-${role}` }).then(response => response.json());
        await f.request(`/runs/${run.id}/workers/${worker.id}/review-evidence`, {});
      }
      expect((await f.request(`/runs/${run.id}/accept`, { head })).status).toBe(200);
      const queue = await f.request(`/projects/${f.project.id}/queue`).then(response => response.json());
      expect(queue.capacity.project_implementations).toBe(0);
      expect(queue.items[0].reasons).toContain("awaiting_delivery");
      const next = await f.request("/implementations", { title: "Independent work", description: "", project_id: f.project.id }).then(response => response.json());
      expect((await f.request(`/implementations/${next.id}/runs`, { action: "work", idempotency_key: "independent" })).status).toBe(202);
    } finally { await f.close(); }
  }, 60_000);
  it("continues accepted Assignments when their Project limit is tightened and paused", async () => {
    const owned: string[] = [];
    const f = await githubScheduleFixture({ native: {
      version: async () => "queue-native-fixture",
      createWorkspace: async options => { const result = await workspaceCreate(options); owned.push(result.workspace.workspace_id); return result; },
      startAgent: async options => { await herdrRpc("pane.report_agent", { pane_id: options.paneId, source: "manual", agent: "codex", state: "working" }); },
    } });
    try {
      const projectId = f.route.split("/")[2], route = `/projects/${projectId}/queue`;
      let queue = (await f.request(route + "/configure", { expected_revision: null, max_implementations: 2, paused: false })).body;
      const runs = [];
      for (const title of ["Accepted A", "Accepted B"]) {
        const idea = (await f.request("/implementations", { title, description: "", project_id: projectId })).body;
        runs.push((await f.request(`/implementations/${idea.id}/runs`, { action: "work", idempotency_key: title.replaceAll(" ", "-") })).body);
      }
      queue = (await f.request(route + "/configure", { expected_revision: queue.revision, max_implementations: 1, paused: true })).body;
      expect(queue.capacity.project_implementations).toBe(2);
      expect(queue.next_implementation_id).toBeNull();
      const worker = (await f.request(`/runs/${runs[0].id}/workers`, { role: "standards", idempotency_key: "accepted-review" })).body;
      expect(worker.condition).toBe("working");
      expect((await f.request(route)).body.capacity.agents).toBe(3);
    } finally { f.close(); for (const id of owned) await workspaceClose(id).catch(() => {}); }
  }, 60_000);
  it("lets another Assignment implement while completed work only has a new planning Run", async () => {
    const owned: string[] = [];
    const f = await githubScheduleFixture({ native: {
      version: async () => "queue-native-fixture",
      createWorkspace: async options => { const result = await workspaceCreate(options); owned.push(result.workspace.workspace_id); return result; },
      startAgent: async options => { await herdrRpc("pane.report_agent", { pane_id: options.paneId, source: "manual", agent: "codex", state: "working" }); },
    } });
    try {
      const projectId = f.route.split("/")[2];
      const a = (await f.request("/implementations", { title: "Previous implementation", description: "", project_id: projectId })).body;
      const b = (await f.request("/implementations", { title: "Next implementation", description: "", project_id: projectId })).body;
      const run = (await f.request(`/implementations/${a.id}/runs`, { action: "work", idempotency_key: "work" })).body;
      await f.request(`/runs/${run.id}/stop`, {});
      expect((await f.request(`/implementations/${a.id}/runs`, { action: "setup", idempotency_key: "new-plan" })).body.condition).toBe("working");
      expect((await f.request(`/projects/${projectId}/queue`)).body.capacity.project_implementations).toBe(0);
      expect((await f.request(`/implementations/${b.id}/runs`, { action: "work", idempotency_key: "next" })).body.condition).toBe("working");
    } finally { f.close(); for (const id of owned) await workspaceClose(id).catch(() => {}); }
  }, 60_000);
  it("counts a running build under a resting chat and retains its reservation after restart", async () => {
    const owned: string[] = [];
    const f = await githubScheduleFixture({ native: {
      version: async () => "queue-native-fixture",
      createWorkspace: async options => { const result = await workspaceCreate(options); owned.push(result.workspace.workspace_id); return result; },
      startAgent: async options => { await herdrRpc("pane.report_agent", { pane_id: options.paneId, source: "manual", agent: "codex", state: "working" }); },
    } });
    let pending: Promise<unknown> | undefined;
    try {
      const projectId = f.route.split("/")[2];
      const gate = join(f.root, "check-gate.mjs");
      const reading = join(f.root, "checking"), release = join(f.root, "continue-check");
      writeFileSync(gate, `import { existsSync, writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(reading)}, "checking"); const deadline=Date.now()+10000; while(!existsSync(${JSON.stringify(release)}) && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,10));`);
      await f.request(`/projects/${projectId}/configure`, { checks: [[process.execPath, gate]] });
      await f.request("/settings", { max_builds: 1 });
      const idea = (await f.request("/implementations", { title: "Build owned work", description: "", project_id: projectId })).body;
      const run = (await f.request(`/implementations/${idea.id}/runs`, { action: "work", idempotency_key: "build" })).body;
      await herdrRpc("pane.report_agent", { pane_id: run.pane_id, source: "manual", agent: "codex", state: "idle" });
      await f.request(`/runs/${run.id}/reconcile`, {});
      pending = f.request(`/runs/${run.id}/checks`, {}).catch(() => null);
      const deadline = Date.now() + 5000;
      while (!existsSync(reading) && Date.now() < deadline) await Bun.sleep(10);
      expect(existsSync(reading)).toBe(true);
      let queue = (await f.request(`/projects/${projectId}/queue`)).body;
      expect(queue.capacity).toMatchObject({ agents: 0, builds: 1, project_implementations: 1, implementations: 1 });
      f.restart(); await pending;
      queue = (await f.request(`/projects/${projectId}/queue`)).body;
      expect(queue.capacity.builds).toBe(1);
      const detail = (await f.request(`/implementations/${idea.id}`)).body;
      expect(detail.checks[0].condition).toBe("interrupted");
      expect(owned).toHaveLength(1);
    } finally { writeFileSync(join(f.root, "continue-check"), "release"); await pending; f.close(); for (const id of owned) await workspaceClose(id).catch(() => {}); }
  }, 60_000);
  it("requires owner Retry for a failed attempt and never relaunches by reading or restarting the queue", async () => {
    let versions = 0; let fail = true;
    const owned: string[] = [];
    const f = await githubScheduleFixture({ native: {
      version: async provider => provider === "codex" && ++versions === 2 && fail ? "changed-after-admission" : "queue-native-fixture",
      createWorkspace: async options => { const result = await workspaceCreate(options); owned.push(result.workspace.workspace_id); return result; },
      startAgent: async options => { await herdrRpc("pane.report_agent", { pane_id: options.paneId, source: "manual", agent: "codex", state: "working" }); },
    } });
    try {
      const projectId = f.route.split("/")[2];
      const idea = (await f.request("/implementations", { title: "Retry owned work", description: "", project_id: projectId })).body;
      const start = (key: string) => f.request(`/implementations/${idea.id}/runs`, { action: "work", idempotency_key: key });
      const failed = (await start("failed")).body;
      expect(failed.condition).toBe("failed");
      fail = false;
      expect((await start("replacement")).body.error.code).toBe("retry_required");
      f.restart();
      const queue = (await f.request(`/projects/${projectId}/queue`)).body;
      expect(queue.items.find((item: { implementation_id: string }) => item.implementation_id === idea.id).reasons).toContain("retry_required");
      expect(owned).toHaveLength(0);
      expect((await f.request(`/implementations/${idea.id}/retry`, { run_id: "another-run" })).status).toBe(409);
      expect((await f.request(`/implementations/${idea.id}/retry`, { run_id: failed.id })).status).toBe(200);
      const retried = (await start("replacement")).body;
      expect(retried.condition).toBe("working");
      expect(retried.id).not.toBe(failed.id);
      expect((await start("replacement")).body.id).toBe(retried.id);
      expect(owned).toHaveLength(1);
    } finally { f.close(); for (const id of owned) await workspaceClose(id).catch(() => {}); }
  }, 60_000);
  it("pauses new starts, preserves active children and reconciles native ownership before restart admission", async () => {
    const owned: string[] = [];
    let unavailable = false;
    const f = await githubScheduleFixture({ native: {
      version: async () => "queue-native-fixture",
      createWorkspace: async options => { const result = await workspaceCreate(options); owned.push(result.workspace.workspace_id); return result; },
      startAgent: async options => { await herdrRpc("pane.report_agent", { pane_id: options.paneId, source: "manual", agent: "codex", state: "working" }); },
      snapshot: async () => { if (unavailable) throw new Error("Owned native fixture offline"); return sessionSnapshot(); },
    } });
    try {
      const projectId = f.route.split("/")[2];
      const a = (await f.request("/implementations", { title: "Queue A", description: "", project_id: projectId })).body;
      const b = (await f.request("/implementations", { title: "Queue B", description: "", project_id: projectId })).body;
      const start = (id: string, key: string) => f.request(`/implementations/${id}/runs`, { action: "work", idempotency_key: key });
      const run = (await start(a.id, "a")).body;
      expect(run.condition).toBe("working");
      const queueRoute = `/projects/${projectId}/queue`;
      let queue = (await f.request(queueRoute)).body;
      expect(queue.capacity.project_implementations).toBe(1);
      expect((await start(b.id, "b")).body.error.code).toBe("project_capacity_exhausted");
      queue = (await f.request(queueRoute + "/configure", { expected_revision: queue.revision, max_implementations: 1, paused: true })).body;
      expect((await start(b.id, "b")).body.error.code).toBe("queue_paused");
      const worker = (await f.request(`/runs/${run.id}/workers`, { role: "standards", idempotency_key: "a-review" })).body;
      expect(worker.condition).toBe("working");
      expect(owned).toHaveLength(2);
      await herdrRpc("pane.report_agent", { pane_id: run.pane_id, source: "manual", agent: "codex", state: "idle" });
      await f.request(`/runs/${run.id}/reconcile`, {});
      queue = (await f.request(queueRoute + "/configure", { expected_revision: queue.revision, max_implementations: 1, paused: false })).body;
      expect(queue.capacity.project_implementations).toBe(1);
      unavailable = true; f.restart();
      expect((await start(b.id, "b")).body.error.code).toBe("project_capacity_exhausted");
      const retained = (await f.request(`/implementations/${a.id}`)).body;
      expect(retained.runs[0]).toMatchObject({ id: run.id, condition: "disconnected" });
      expect(retained.workers[0]).toMatchObject({ id: worker.id, condition: "disconnected" });
      expect(owned).toHaveLength(2);
      unavailable = false;
      await f.request(`/runs/${run.id}/workers/${worker.id}/stop`, {});
      await f.request(`/runs/${run.id}/stop`, {});
      expect((await start(b.id, "b")).body.condition).toBe("working");
    } finally { f.close(); for (const id of owned) await workspaceClose(id).catch(() => {}); }
  }, 60_000);
  it("selects board priority among eligible issues while dependencies and paused work stay held", async () => {
    const f = await githubScheduleFixture();
    try {
      const policy = (await f.request(f.route + "/configure", { ...f.policy, auto_implement: true })).body;
      writeFileSync(f.responses, JSON.stringify({ issues: [1, 2, 3, 4].map(number => ({ number, node_id: `I_QUEUE_${number}`, title: `Queue issue ${number}`, body: "Reviewed fictional work", state: "open", html_url: `https://github.com/fictional/schedules/issues/${number}`, updated_at: "2026-10-14T09:00:00Z", labels: [{ name: number === 3 ? "needs-info" : "ready-for-agent" }] })) }));
      const sources = (await f.request(f.route + "/sync", {})).body.sources;
      for (const number of [1, 2, 4]) {
        const source = sources.find((item: { number: number }) => item.number === number);
        const approved = await f.request(f.route + `/issues/${number}/approve`, { issue_revision: source.revision, policy_revision: policy.revision, plan: { acceptance_criteria: "Owned queue work passes checks", testing_seams: ["Public API"], planning_decisions: [], dependencies: number === 1 ? [{ repository: "fictional/schedules", issue_number: 90, requires: "merge" }] : [] } });
        expect(approved.status).toBe(200);
      }
      const queueRoute = f.route.replace(/\/github$/, "/queue");
      const id = (number: number) => sources.find((source: { number: number }) => source.number === number).implementation_id;
      let queue = (await f.request(queueRoute)).body;
      expect(queue.next_implementation_id).toBe(id(2));
      expect(queue.items.find((item: { implementation_id: string }) => item.implementation_id === id(1)).reasons).toContain("dependency_unverified");
      expect(queue.items.find((item: { implementation_id: string }) => item.implementation_id === id(3)).reasons).toContain("start_planning");
      await f.request(`/implementations/${id(4)}/order`, { before_id: id(1) });
      queue = (await f.request(queueRoute)).body;
      expect(queue.next_implementation_id).toBe(id(4));
      queue = (await f.request(queueRoute + "/configure", { expected_revision: queue.revision, max_implementations: 1, paused: true })).body;
      expect(queue.next_implementation_id).toBeNull();
      expect(queue.items.find((item: { implementation_id: string }) => item.implementation_id === id(4)).reasons).toContain("queue_paused");
      expect((await f.request("/implementations/" + id(4))).body.runs).toEqual([]);
      queue = (await f.request(queueRoute + "/configure", { expected_revision: queue.revision, max_implementations: 1, paused: false })).body;
      expect(queue.next_implementation_id).toBe(id(4));
    } finally { f.close(); }
  });
  it("defaults to one Assignment and saves bounded capacity and pause controls across restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "saurons-queue-"));
    const repo = join(root, "repo");
    execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
    writeFileSync(join(repo, "README.md"), "Owned queue fixture\n");
    for (const args of [["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture"]]) execFileSync("git", args, { cwd: repo, stdio: "ignore" });
    const options = { port: 0, stateDir: join(root, "state"), token: "", machines: false, factory: { accountDiscoveryHome: root } };
    let app = createServer(options);
    const request = async (path: string, body?: unknown) => {
      const response = await fetch(`http://localhost:${app.port}/api/factory${path}`, { headers: { "content-type": "application/json", "x-herdr-factory": "1" }, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
      return { status: response.status, body: await response.json() };
    };
    try {
      const project = (await request("/projects", { name: "Queue fixture", path: repo, provider: "codex", machine_id: "local", tracker: "app" })).body;
      const route = `/projects/${project.id}/queue`;
      let queue = await request(route);
      expect(queue.status).toBe(200);
      expect(queue.body).toMatchObject({ max_implementations: 1, effective_limit: 1, paused: false, next_implementation_id: null, items: [] });
      const save = (body: unknown) => request(route + "/configure", body);
      expect((await save({ expected_revision: queue.body.revision, max_implementations: 3, paused: false })).status).toBe(400);
      const saved = await save({ expected_revision: queue.body.revision, max_implementations: 2, paused: true });
      expect(saved.status).toBe(200);
      expect(saved.body).toMatchObject({ max_implementations: 2, effective_limit: 2, paused: true });
      expect((await save({ expected_revision: queue.body.revision, max_implementations: 1, paused: false })).body.error.code).toBe("queue_changed");
      app.stop(); app = createServer(options);
      queue = await request(route);
      expect(queue.body).toMatchObject({ max_implementations: 2, paused: true, revision: saved.body.revision });
      await request("/settings", { max_agents: 1 });
      expect((await request(route)).body.effective_limit).toBe(1);
      const resumed = await save({ expected_revision: saved.body.revision, max_implementations: 2, paused: false });
      expect(resumed.status).toBe(200);
      expect(resumed.body).toMatchObject({ max_implementations: 2, effective_limit: 1, paused: false });
      expect((await save({ expected_revision: resumed.body.revision, max_implementations: 1, paused: false })).body.max_implementations).toBe(1);
    } finally { app.stop(); rmSync(root, { recursive: true, force: true }); }
  });
});
