/** Owned Machine HTTP fixture. No paid processes or owner workspaces are used. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../server/index.ts";
import type { FactoryRun, FactoryWorker, NativeConversationSnapshot } from "../shared/factory.ts";

export async function capacityFixture() {
  const state = mkdtempSync(join(tmpdir(), "factory-capacity-"));
  const token = "owned-capacity-fixture";
  const runs = new Map<string, FactoryRun>(); const workers = new Map<string, FactoryWorker>();
  let allocationGate: { worker: boolean; entered: (id: string) => void; wait: Promise<void> } | null = null;
  let admissionGate: { entered: () => void; wait: Promise<void> } | null = null;
  let rejectSend = false;
  let loseResume = false;
  const resumptions: string[] = [];
  const resumeHistories: unknown[] = [];
  let loseSend = false; let loseLaunch = false; let loseWorker = false; let loseCheck = false; let offline = false; let uncertain = false;
  const prompts: { run_id: string; text: string; worker_id?: string }[] = [];
  const launches: string[] = [];
  const workerLaunches: string[] = [];
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
        if (loseCheck) { loseCheck = false; return Response.json({ error: { code: "lost_ack", message: "Owned uncertain check" } }, { status: 503 }); }
        return Response.json({ ...body.check, head: "1".repeat(40), workspace_hash: "owned-check", condition: "passed" });
      }
      if (action === "operations/head") return Response.json({ head: "1".repeat(40) });
      if (action === "operations/worker") {
        workerLaunches.push(body.worker.id);
        const worker = { ...body.worker, condition: "working", worktree: join(state, body.worker.id), branch: `owned-${body.worker.id}` } as FactoryWorker;
        workers.set(worker.id, worker);
        const launchResponse = structuredClone(worker);
        if (allocationGate?.worker) { const gate = allocationGate; allocationGate = null; gate.entered(worker.id); await gate.wait; }
        if (loseWorker) { loseWorker = false; return Response.json({ error: { code: "lost_ack", message: "Owned lost worker acknowledgment" } }, { status: 503 }); }
        return Response.json(launchResponse);
      }
      if (action === "operations/send-worker") { prompts.push({ run_id: run.id, worker_id: body.worker_id, text: body.text }); workers.get(body.worker_id)!.condition = "working"; return Response.json({ ok: true }); }
      if (action === "operations/refresh") { const worker = workers.get(body.worker_id)!; worker.head = "1".repeat(40); return Response.json(worker); }
      if (action === "operations/integrate") { const worker = workers.get(body.worker_id)!; worker.condition = "completed"; return Response.json(worker); }
      if (action === "operations/reconcile-worker") return Response.json(workers.get(body.worker_id));
      if (action === "operations/stop-worker") { const worker = workers.get(body.worker_id)!; worker.condition = "cancelled"; return Response.json(worker); }
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
  return { api, agent, assignment, runs, workers, launches, workerLaunches, resumptions, resumeHistories, prompts, state, token, get app() { return app; },
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
    loseNextLaunch: () => { loseLaunch = true; },
    loseNextWorker: () => { loseWorker = true; },
    loseNextCheck: () => { loseCheck = true; },
    restart: () => { app.stop(); app = createServer(options); },
    close: () => { app.stop(); machine.stop(true); rmSync(state, { recursive: true, force: true }); },
  };
}
