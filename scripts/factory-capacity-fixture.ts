/** Owned Machine HTTP fixture. No paid processes or owner workspaces are used. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../server/index.ts";
import type { FactoryCheck, FactoryRun, FactoryWorker, NativeConversationSnapshot } from "../shared/factory.ts";

export async function capacityFixture(scenario: { advancingHeads?: boolean } = {}) {
  const tips = new Map<string, string>(); let candidate = 1;
  const state = mkdtempSync(join(tmpdir(), "factory-capacity-"));
  const token = "owned-capacity-fixture";
  const checks = new Map<string, FactoryCheck>();
  const executedChecks: string[] = [];
  let loseIntegration = false; let failCheck = false; let conflict = false;
  let checkGate: { entered: () => void; wait: Promise<void> } | null = null;
  const runs = new Map<string, FactoryRun>(); const workers = new Map<string, FactoryWorker>();
  let allocationGate: { worker: boolean; entered: (id: string) => void; wait: Promise<void> } | null = null;
  let admissionGate: { entered: () => void; wait: Promise<void> } | null = null;
  let rejectSend = false;
  let loseResume = false;
  let loseDelete = false;
  const resumptions: string[] = [];
  const resumeHistories: unknown[] = [];
  let loseSend = false; let loseLaunch = false; let loseWorker = false; let loseCheck = false; let offline = false; let uncertain = false;
  const prompts: { run_id: string; text: string; worker_id?: string }[] = [];
  const launches: string[] = [];
  const workerLaunches: string[] = [];
  const reviewOutcomes = new Map<string, "passed" | "failed">();
  const workerContexts = new Map<string, any>();
  const publications = new Map<string, any>();
  let losePublication = false;
  let loseStop = false;
  let denyPublication = false;
  let capabilities: Record<string, any> | null = null;
  let transcript: Pick<NativeConversationSnapshot, "source_id" | "version" | "cursor" | "turns"> = { source_id: "owned-transcript", version: "v1", cursor: null, turns: [] };
  const access = new Map<string, { url: string; token: string }>();
  let app: ReturnType<typeof createServer>;
  const machine = Bun.serve({ port: 0, async fetch(request) {
    if (request.headers.get("authorization") !== `Bearer ${token}`) return Response.json({ error: { code: "unauthorized", message: "Owned fixture credential required" } }, { status: 401 });
    const path = new URL(request.url).pathname.replace("/api/factory-host", "");
    if (offline || uncertain && (path.endsWith("/reconcile") || path.endsWith("/resume-status"))) return Response.json({ error: { code: "disconnected", message: "Owned unavailable Machine" } }, { status: 503 });
    const body = request.method === "POST" ? await request.json() as Record<string, any> : {};
    if (path === "/capabilities") {
      if (admissionGate) { const gate = admissionGate; admissionGate = null; gate.entered(); await gate.wait; }
      capabilities ??= await api("/providers").then(r => r.json());
      return Response.json({ ...capabilities, providers: capabilities!.providers.map((p: object) => ({ ...p, factory_ready: true })) });
    }
    if (path === "/inspect") return Response.json({ path: body.path, repository: `owned-repo:${body.path}`, head: "1".repeat(40), branch: "main", instructions: [] });
    if (path === "/launch") {
      launches.push(body.run.id);
      const run = { ...body.run, condition: "working", worktree: join(state, body.run.id), branch: `owned-${body.run.id}`, workspace_id: null, pane_id: null } as FactoryRun;
      runs.set(run.id, run); access.set(run.id, body.access);
      if (allocationGate && !allocationGate.worker) { const gate = allocationGate; allocationGate = null; gate.entered(run.id); await gate.wait; }
      if (loseLaunch) { loseLaunch = false; return Response.json({ error: { code: "lost_ack", message: "Owned lost acknowledgment" } }, { status: 503 }); }
      return Response.json(run);
    }
    const deleteRoute = /^\/runs\/([^/]+)\/operations\/delete$/.exec(path);
    if (deleteRoute) {
      const runId = deleteRoute[1]!;
      runs.delete(runId);
      for (const worker of workers.values()) if (worker.run_id === runId) workers.delete(worker.id);
      if (loseDelete) { loseDelete = false; return Response.json({ error: { code: "lost_ack", message: "Owned lost deletion acknowledgment" } }, { status: 503 }); }
      return Response.json({ run_id: runId, deletion_id: body.deletion_id, condition: "deleted" });
    }
    const route = /^\/runs\/([^/]+)\/(.*)$/.exec(path);
    const run = route ? runs.get(route[1]!) : undefined;
    if (run) {
      const action = route![2];
      if (action === "operations/pause") {
        const suspension = { pause_id: body.pause_id, condition: "stopped" as const, previous_condition: run.condition };
        run.suspension ??= suspension;
        run.condition = "ready";
        const children = [...workers.values()].filter(w => w.run_id === run.id && !["completed", "cancelled", "failed"].includes(w.condition));
        for (const worker of children) { worker.suspension ??= { ...suspension, previous_condition: worker.condition }; worker.condition = "ready"; }
        return Response.json({ run, workers: children, checks: [] });
      }
      if (action === "operations/resume-context") {
        const target = body.worker_id ? workers.get(body.worker_id)! : run;
        resumptions.push(target.id);
        resumeHistories.push(body.history);
        delete target.suspension; target.condition = "working";
        if (loseResume) { loseResume = false; return Response.json({ error: { code: "lost_ack", message: "Owned lost continuation acknowledgment" } }, { status: 503 }); }
        return Response.json(target);
      }
      if (action === "operations/resume-status") return Response.json(body.worker_id ? workers.get(body.worker_id)! : run);
      if (action === "operations/transcript") return Response.json(transcript);
      if (action === "reconcile") return Response.json(run);
      if (action === "artifacts") return Response.json([]);
      if (action === "finish") { run.condition = "completed"; return Response.json(run); }
      if (action === "send") { if (rejectSend) { rejectSend = false; run.condition = "needs_you"; return Response.json({ error: { code: "agent_blocked", message: "Owned native permission arrived before delivery" } }, { status: 409 }); } prompts.push({ run_id: run.id, text: body.text }); run.condition = "working"; if (loseSend) { loseSend = false; return Response.json({ error: { code: "lost_ack", message: "Owned lost continuation acknowledgment" } }, { status: 503 }); } return Response.json({ ok: true }); }
      if (action === "stop") { run.condition = "cancelled"; return Response.json(run); }
      if (action === "operations/check") {
        const checked = { ...body.check, head: scenario.advancingHeads ? (body.worker_id ? workers.get(body.worker_id)?.head : tips.get(run.id)) ?? "1".repeat(40) : "1".repeat(40), workspace_hash: "owned-check", commands: [{ args: ["bun", "test"], exit_code: 0, output: "Owned checks passed" }], condition: "passed" } as FactoryCheck;
        if (failCheck) { failCheck = false; checked.condition = "failed"; checked.commands[0]!.exit_code = 1; checked.commands[0]!.output = "Owned check failure"; }
        checks.set(checked.id, checked); executedChecks.push(checked.id);
        if (checkGate) { const gate = checkGate; checkGate = null; gate.entered(); await gate.wait; }
        if (loseCheck) { loseCheck = false; return Response.json({ error: { code: "lost_ack", message: "Owned uncertain check" } }, { status: 503 }); }
        return Response.json(checked);
      }
      if (action === "operations/check-reconcile") return Response.json(checks.get(body.check_id));
      if (action === "operations/head") return Response.json({ head: tips.get(run.id) ?? "1".repeat(40), workspace_hash: "owned-check" });
      if (action === "operations/review-evidence") {
        const worker = workers.get(body.worker_id)!;
        const outcome = reviewOutcomes.get(worker.id) ?? "passed";
        return Response.json({ head: worker.base, source_id: `owned-report-${worker.id}`, content: outcome === "passed" ? "FACTORY_REVIEW: PASS\nOwned independent review passed" : "FACTORY_REVIEW: FAIL\nThe accepted result loses the owner's draft on reload", outcome });
      }
      if (action === "operations/publish") {
        if (denyPublication) return Response.json({ error: { code: "publication_unconfigured", message: "Unsafe remote diagnostic must not be copied" } }, { status: 409 });
        if (!publications.has(run.id)) publications.set(run.id, { run_id: run.id, head: body.head, repository: "fictional/project", base_branch: "main", branch: run.branch, number: 27, url: "https://github.com/fictional/project/pull/27" });
        if (losePublication) { losePublication = false; return Response.json({ error: { code: "lost_ack", message: "Owned lost publication acknowledgment" } }, { status: 503 }); }
        return Response.json(publications.get(run.id));
      }
      if (action === "operations/worker") {
        workerContexts.set(body.worker.id, body.context);
        workerLaunches.push(body.worker.id);
        const worker = { ...body.worker, condition: "working", worktree: join(state, body.worker.id), branch: `owned-${body.worker.id}` } as FactoryWorker;
        workers.set(worker.id, worker);
        const launchResponse = structuredClone(worker);
        if (allocationGate?.worker) { const gate = allocationGate; allocationGate = null; gate.entered(worker.id); await gate.wait; }
        if (loseWorker) { loseWorker = false; return Response.json({ error: { code: "lost_ack", message: "Owned lost worker acknowledgment" } }, { status: 503 }); }
        return Response.json(launchResponse);
      }
      if (action === "operations/send-worker") { prompts.push({ run_id: run.id, worker_id: body.worker_id, text: body.text }); workers.get(body.worker_id)!.condition = "working"; return Response.json({ ok: true }); }
      if (action === "operations/refresh") { if (conflict) return Response.json({ error: { code: "integration_conflict", message: "Unsafe remote diagnostic must not be copied" } }, { status: 409 }); const worker = workers.get(body.worker_id)!;
        if (scenario.advancingHeads && worker.condition === "completed") return Response.json({ error: { code: "worker_busy", message: "A merged worker no longer owns a native pane" } }, { status: 409 });
        worker.integration_tip = tips.get(run.id) ?? "1".repeat(40);
        worker.head ??= scenario.advancingHeads ? (++candidate).toString(16).padStart(40, "0") : "1".repeat(40);
        return Response.json(worker); }
      if (action === "operations/integrate") { const worker = workers.get(body.worker_id)!; worker.condition = "completed"; if (scenario.advancingHeads) tips.set(run.id, worker.head!); if (loseIntegration) { loseIntegration = false; return Response.json({ error: { code: "lost_ack", message: "Owned lost merger acknowledgment" } }, { status: 503 }); } return Response.json(worker); }
      if (action === "operations/reconcile-worker") return Response.json(workers.get(body.worker_id));
      if (action === "operations/stop-worker") { const worker = workers.get(body.worker_id)!; if (worker.condition !== "completed") worker.condition = "cancelled"; if (loseStop) { loseStop = false; return Response.json({ error: { code: "lost_ack", message: "Owned lost shutdown acknowledgment" } }, { status: 503 }); } return Response.json(worker); }
    }
    return Response.json({ error: { code: "not_found", message: `Unimplemented owned Machine fixture route: ${path}` } }, { status: 404 });
  } });
  const options = { port: 0, token, stateDir: state, machines: false as const, factory: { accountDiscoveryHome: state, native: { version: async () => "owned-capacity-cli" }, machineEndpoint: (id: string) => id.startsWith("owned-") ? { url: `http://localhost:${machine.port}`, token } : undefined } };
  app = createServer(options);
  function api(path: string, body?: unknown) {
    return fetch(`http://localhost:${app.port}/api/factory${path}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-herdr-factory": "1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  async function assignment(title: string, provider = "codex", machineId = "owned-a") {
    const project = await api("/projects", { name: `${title} Project`, path: join(state, title), machine_id: machineId, provider, tracker: "app" }).then(r => r.json());
    const idea = await api("/implementations", { title, description: "Owned capacity scenario", project_id: project.id }).then(r => r.json());
    return idea.id as string;
  }
  const agent = (id: string, path: string, body?: unknown) => {
    const credential = access.get(id)!;
    return fetch(`http://localhost:${app.port}${new URL(credential.url).pathname}/${path}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${credential.token}`, "content-type": "application/json", "x-herdr-factory": "1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  };
  return { api, agent, assignment, runs, workers, launches, workerLaunches, workerContexts, reviewOutcomes, publications, executedChecks, resumptions, resumeHistories, prompts, state, token, get app() { return app; },
    loseNextPublication: () => { losePublication = true; },
    denyPublication: () => { denyPublication = true; },
    changeHead: (runId: string, head: string) => { tips.set(runId, head); },
    loseNextStop: () => { loseStop = true; },
    holdNextAdmission: () => {
      let entered!: () => void; let release!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      const wait = new Promise<void>(resolve => { release = resolve; });
      admissionGate = { entered, wait }; return { started, release };
    },
    holdNextAllocation: (worker = false) => {
      let entered!: (id: string) => void; let release!: () => void;
      const started = new Promise<string>(resolve => { entered = resolve; });
      const wait = new Promise<void>(resolve => { release = resolve; });
      allocationGate = { worker, entered, wait };
      return { started, release };
    },
    setTranscript: (value: typeof transcript) => { transcript = value; },
    offline: (value: boolean) => { offline = value; },
    uncertain: (value: boolean) => { uncertain = value; },
    blockNextSend: () => { rejectSend = true; },
    loseNextSend: () => { loseSend = true; },
    loseNextResume: () => { loseResume = true; },
    loseNextDelete: () => { loseDelete = true; },
    loseNextLaunch: () => { loseLaunch = true; },
    loseNextWorker: () => { loseWorker = true; },
    loseNextCheck: () => { loseCheck = true; },
    loseNextIntegration: () => { loseIntegration = true; },
    failNextCheck: () => { failCheck = true; },
    integrationConflict: (value: boolean) => { conflict = value; },
    holdNextCheck: () => {
      let entered!: () => void; let release!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      const wait = new Promise<void>(resolve => { release = resolve; });
      checkGate = { entered, wait }; return { started, release };
    },
    restart: () => { app.stop(); app = createServer(options); },
    close: () => { app.stop(); machine.stop(true); rmSync(state, { recursive: true, force: true }); },
  };
}
