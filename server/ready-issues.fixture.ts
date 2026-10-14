import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "./index.ts";
import { githubScheduleFixture } from "./github-schedules.fixture.ts";
import type { FactoryRun, FactoryWorker } from "../shared/factory.ts";

/** An owned external Machine speaks the public host protocol and creates real Git worktrees.
 * It models certified native responses; it cannot certify a production provider. */
export async function readyIssuesFixture() {
  const base = await githubScheduleFixture({ version: async () => "owned-ready-provider" });
  const repo = join(base.root, "repo");
  const runs = new Map<string, FactoryRun>();
  const launches: FactoryRun[] = [];
  const workers = new Map<string, FactoryWorker>();
  const git = (path: string, args: string[]) => execFileSync("git", ["-C", path, ...args], { encoding: "utf8" }).trim();
  const head = (path: string) => ({ head: git(path, ["rev-parse", "HEAD"]), workspace_hash: git(path, ["rev-parse", "HEAD"]) + ":" + git(path, ["status", "--porcelain"]) });
  let failLaunch = false, offline = false;
  const host = Bun.serve({ port: 0, async fetch(request) {
    const url = new URL(request.url);
    const body = request.method === "POST" ? await request.json() as any : {};
    if (offline) return new Response(null, { status: 503 });
    if (url.pathname.endsWith("/capabilities")) {
      const capabilities = (await base.request("/providers")).body;
      capabilities.providers = capabilities.providers.map((provider: any) => ({ ...provider, factory_ready: true, reasons: [] }));
      return Response.json(capabilities);
    }
    if (url.pathname.endsWith("/launch")) {
      const run: FactoryRun = body.run;
      launches.push(run);
      if (failLaunch) { const failed = { ...run, condition: "failed" as const, waiting_reason: "Owned pre-allocation failure" }; runs.set(run.id, failed); return Response.json(failed); }
      const worktree = join(base.root, "native", run.id); mkdirSync(join(base.root, "native"), { recursive: true });
      execFileSync("git", ["-C", repo, "worktree", "add", "-b", `owned/${run.id}`, worktree, run.base!], { stdio: "ignore" });
      const launched = { ...run, worktree, branch: `owned/${run.id}`, workspace_id: `owned-${run.id}`, pane_id: `owned-${run.id}:p1`, condition: "working" as const };
      runs.set(run.id, launched); return Response.json(launched);
    }
    const nativeOperation = /\/runs\/([^/]+)\/operations\/([^/]+)$/.exec(url.pathname);
    if (nativeOperation) {
      const run = runs.get(nativeOperation[1]!)!;
      const action = nativeOperation[2];
      const worker = workers.get(body.worker_id);
      if (action === "head") return Response.json(head(run.worktree!));
      if (action === "transcript") return Response.json({ source_id: `owned:${run.id}`, version: "1", cursor: null, turns: [] });
      if (action === "worker") {
        const record: FactoryWorker = body.worker;
        const worktree = join(base.root, "native", record.id), branch = `owned/${record.id}`;
        execFileSync("git", ["-C", repo, "worktree", "add", "-b", branch, worktree, record.base!], { stdio: "ignore" });
        const next = { ...record, worktree, branch, pane_id: `owned-${record.id}:p1`, workspace_id: `owned-${record.id}`, condition: "working" as const };
        workers.set(record.id, next); return Response.json(next);
      }
      if (action === "reconcile-worker" || action === "refresh") return Response.json({ ...worker, head: head(worker!.worktree!).head });
      if (action === "check") {
        const path = worker?.worktree ?? run.worktree!;
        const commands = (run.manifest as { project: { checks: string[][] } }).project.checks.map(args => {
          try { return { args, exit_code: 0, output: execFileSync(args[0]!, args.slice(1), { cwd: path, encoding: "utf8" }) }; }
          catch { return { args, exit_code: 1, output: "Owned check failed" }; }
        });
        return Response.json({ ...body.check, ...head(path), commands, condition: commands.every(command => command.exit_code === 0) ? "passed" : "failed" });
      }
      if (action === "integrate") {
        git(run.worktree!, ["merge", "--ff-only", worker!.head!]);
        const next = { ...worker!, condition: "completed" as const };
        workers.set(worker!.id, next); return Response.json(next);
      }
      if (action === "stop-worker") {
        workers.set(worker!.id, { ...worker!, condition: worker!.condition === "completed" ? "completed" : "cancelled" });
        return Response.json({ ok: true });
      }
      if (action === "review-evidence") return Response.json({ head: worker!.base, source_id: `owned-independent:${worker!.id}`, content: `Owned ${worker!.role} review`, outcome: "passed" });
    }
    const operation = /\/runs\/([^/]+)\/(reconcile|stop|finish)$/.exec(url.pathname);
    if (operation) {
      const run = runs.get(operation[1]!)!;
      const next = operation[2] === "stop" ? { ...run, condition: "cancelled" as const } : operation[2] === "finish" ? { ...run, condition: "completed" as const } : run;
      runs.set(run.id, next); return Response.json(next);
    }
    const response = await fetch(base.origin() + url.pathname + url.search, { method: request.method, headers: base.headers, ...(request.method === "POST" ? { body: JSON.stringify(body) } : {}) });
    const headers = new Headers(response.headers); headers.delete("content-encoding"); headers.delete("content-length");
    return new Response(response.body, { status: response.status, headers });
  } });
  let poll: () => Promise<void> = async () => {};
  const options = { port: 0, token: "", machines: false as const, stateDir: join(base.root, "coordinator"), factory: {
    accountDiscoveryHome: base.root, accountTools: { github: { executable: process.execPath, args: [join(base.root, "gh.mjs")] } },
    machineEndpoint: (id: string) => id === "owned-host" ? { url: `http://localhost:${host.port}`, token: "owned-host" } : undefined,
    scheduleTiming: { subscribe: (run: () => Promise<void>) => { poll = run; return () => {}; } },
  } };
  let app = createServer(options);
  const origin = () => `http://localhost:${app.port}`;
  const request = async (path: string, body?: unknown) => {
    const response = await fetch(origin() + "/api/factory" + path, { headers: base.headers, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  const profile = (await request("/machines/local/accounts", { name: "Ready issue fixture", service: "github", expected_login: "fictional-owner" })).body;
  await request(`/machines/local/accounts/${profile.id}/verify`, { expected_revision: profile.revision });
  const project = (await request("/projects", { name: "Ready issues", path: repo, provider: "codex", machine_id: "owned-host", tracker: "app" })).body;
  await request(`/projects/${project.id}/configure`, { checks: [["git", "status", "--porcelain"]], permissions: "Owned fixture work only" });
  const route = `/projects/${project.id}/github`;
  const policy = { ...base.policy, account_profile_id: profile.id, auto_implement: true };
  const issue = (number: number, labels = ["ready-for-agent"]) => ({ number, node_id: `OWNED_READY_${number}`, title: `Ready issue ${number}`, body: "Preserve the accepted behavior", html_url: `https://github.com/fictional/schedules/issues/${number}`, state: "open", labels: labels.map(name => ({ name })), updated_at: "2026-10-14T09:00:00Z" });
  const plan = { acceptance_criteria: "Owner decisions survive automatic implementation", testing_seams: ["Public HTTP/API and browser journeys"], planning_decisions: ["One Assignment per deliverable"], dependencies: [] };
  const respond = (value: object) => writeFileSync(base.responses, JSON.stringify(value));
  return { ...base, origin, request, project, route, policy, issue, plan, respond, launches,
    repo, hostAccountId: base.policy.account_profile_id,
    rest: (id: string) => { runs.set(id, { ...runs.get(id)!, condition: "ready" }); },
    restWorker: (id: string) => { const worker = workers.get(id)!; workers.set(id, { ...worker, ...head(worker.worktree!), condition: "ready" }); },
    tick: () => poll(), restart: () => { app.stop(); app = createServer(options); },
    failLaunch: (value: boolean) => { failLaunch = value; }, offline: (value: boolean) => { offline = value; },
    close: () => { app.stop(); host.stop(); base.close(); },
  };
}
