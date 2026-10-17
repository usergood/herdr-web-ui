/** An owned connection server forwards the UI's unchanged approval to a real Git Machine. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../server/index.ts";
import { FactoryStore } from "../server/factory-store.ts";
import { mergeFixture } from "./factory-merge-fixture.ts";

export async function releaseBrowserFixture() {
  const core = await mergeFixture({ milestone: "release", machineId: "owned-release", native: { version: async () => "owned-release", modelCatalog: async provider => ({ protocol: 1, provider, models: [{ id: "owned-release-model", name: "Owned release model", reasoning: [], default_reasoning: null }], problem: null }) } });
  const stateDir = mkdtempSync(join(tmpdir(), "release-browser-"));
  const token = "owned-release-browser";
  const mergeRequests: Record<string, any>[] = [];
  const pending = new Set<Promise<Response>>();
  const forward = async (request: Request) => {
    if (request.headers.get("authorization") !== "Bearer owned-merge") return new Response(null, { status: 401 });
    const path = new URL(request.url).pathname.replace(/^\/api\/factory-host/, "");
    const body = request.method === "POST" ? await request.json() as Record<string, any> : {};
    if (path === `/runs/${core.id}/operations/transcript`) return Response.json({ source_id: "owned-release-history", version: "one", cursor: null, turns: [{ role: "assistant", ts: "2026-10-16T00:00:00.000Z", parts: [{ kind: "text", text: "Retained containing release history." }] }] });
    if (path === `/runs/${core.id}/operations/merge`) mergeRequests.push(structuredClone(body));
    const response = await core.post(`factory-host${path}`, body);
    return Response.json(await response.json(), { status: response.status });
  };
  const machine = Bun.serve({ port: 0, async fetch(request) {
    const response = forward(request); pending.add(response);
    try { return await response; } finally { pending.delete(response); }
  } });
  const drain = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        (async () => { while (pending.size) await Promise.all([...pending]); })(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Owned Machine forwards did not drain")), 30000); }),
      ]);
    } finally { clearTimeout(timer); }
  };
  const options = { port: 0, token, stateDir, machines: false as const, factory: { accountDiscoveryHome: stateDir, native: { version: async () => null }, machineEndpoint: (id: string) => id === "owned-release" ? { url: `http://localhost:${machine.port}`, token: "owned-merge" } : undefined } };
  const store = new FactoryStore(stateDir); const record = store.record();
  const id = core.run.implementation_id;
  const manifest = core.run.manifest;
  store.put("projects", { ...manifest.project, machine_id: "owned-release" });
  store.put("checkouts", { ...manifest.checkout, machine_id: "owned-release" }, manifest.project.id);
  store.put("implementations", { ...record, id, title: "Containing release result", project_id: manifest.project.id, provider: "codex", machine_id: "owned-release", stage: "review", outcome: "pr_open", delivery_scope: manifest.implementation.delivery_scope });
  store.put("runs", core.run, id);
  store.put("checks", core.check, core.id);
  for (const axis of ["standards", "spec"]) store.put("review_evidence", { ...record, id: `owned-${axis}`, worker_id: `owned-${axis}`, run_id: core.id, axis, head: core.head, outcome: "passed", source_id: `owned-source-${axis}`, content: "FACTORY_REVIEW: PASS" }, core.id);
  store.put("pull_requests", { ...core.body.pull_request, id: core.id }, core.id);
  store.close();
  let app = createServer(options);
  const prefix = `/api/factory/implementations/${id}`;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json", "x-herdr-factory": "1" };
  const detail = () => fetch(`http://localhost:${app.port}${prefix}`, { headers }).then(response => response.json());
  const current = await detail();
  const capture = await fetch(`http://localhost:${app.port}${prefix}/snapshots`, { method: "POST", headers, body: JSON.stringify({ run_id: core.id, mode: "branch" }) });
  const snapshot = await capture.json(); assert.equal(capture.status, 201, JSON.stringify(snapshot));
  assert.equal(snapshot.head, core.head); assert(snapshot.files.some((file: { path: string }) => file.path === "result.txt"));
  app.stop();
  const retained = new FactoryStore(stateDir);
  retained.put("human_reviews", { ...record, id: core.id, implementation_id: id, run_id: core.id, conversation_id: `${id}:human_review`, head: core.head, snapshot_id: snapshot.id, assistant_run_id: null, condition: "ready", reason: null }, id);
  retained.put("automatic_review", { ...record, id: core.id, run_id: core.id, head: core.head, round: 0, condition: "published", reason: null, attempts: 0, next_attempt_at: 0, check_id: core.check.id, evidence_ids: core.body.evidence_ids, batch_id: null, context_revision: current.question_revision }, id);
  retained.close();
  app = createServer(options);
  return { core, id, prefix, token, detail, mergeRequests, snapshot,
    get app() { return app; },
    restart: async () => { app.stop(); await drain(); core.restart(); app = createServer(options); },
    close: async () => { app.stop(); try { await drain(); } finally { machine.stop(); core.close(); rmSync(stateDir, { recursive: true, force: true }); } },
  };
}
