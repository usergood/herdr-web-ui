import { FactoryStore } from "../../server/factory-store.ts";
import type { FactoryRun, FactoryWorker, Implementation } from "../../shared/factory.ts";

/** Owned durable records representing handoffs; no native CLI or workspace is launched. */
export function seedWorkflowConversations(stateDir: string) {
  const store = new FactoryStore(stateDir);
  const assignment: Implementation = { ...store.record(), id: "workflow-fixture", title: "Workflow history fixture", description: "", project_id: "workflow-project", provider: "codex", machine_id: "local", stage: "running", position: 0, outcome: "none" };
  store.put("implementations", assignment);
  store.put("projects", { ...store.record(), id: "workflow-project", name: "Workflow Project", repository: "owned-fixture", provider: "codex", machine_id: "local", tracker: "app", tracker_reference: "" });
  const run = (id: string, action: FactoryRun["action"], extra: Partial<FactoryRun> = {}): FactoryRun => {
    const value: FactoryRun = { ...store.record(), id, implementation_id: assignment.id, action, provider: "codex", machine_id: "local", condition: "completed", waiting_reason: null, idempotency_key: id, specification_id: null, graph_hash: null, base: null, checkout: null, worktree: `/owned/${id}`, branch: null, workspace_id: `${id}-workspace`, pane_id: `${id}-pane`, ...extra, manifest: { project: { id: "workflow-project" }, ...(extra.manifest as object ?? {}) } };
    store.put("runs", value, assignment.id); return value;
  };
  const interview = run("interview-context", "grill-with-docs");
  const specification = run("specification-context", "to-spec", { condition: "ready" });
  const orchestrator = run("orchestrator-context", "implement-spec", { manifest: { tickets: [{ id: "ticket-fixture", title: "Keep the approved Ticket name" }] } });
  const human = run("human-context", "work", { conversation_kind: "human_review", condition: "ready" });
  // A later rename must not rewrite the frozen worker history.
  store.put("tickets", { ...store.record(), id: "ticket-fixture", implementation_id: assignment.id, specification_id: "spec-fixture", title: "Later Ticket title", acceptance: "Fixture", dependencies: [], status: "done", tracker_reference: null }, assignment.id);
  const worker = (id: string, role: FactoryWorker["role"], extra: Partial<FactoryWorker> = {}) => {
    const value: FactoryWorker = { ...store.record(), id, run_id: orchestrator.id, ticket_id: "ticket-fixture", role, condition: "completed", base: "fixture-base", head: "fixture-head", integration_tip: "fixture-base", worktree: `/owned/${id}`, branch: null, workspace_id: `${id}-workspace`, pane_id: `${id}-pane`, shared_paths: [], waiting_reason: null, rework_batch_id: null, ...extra };
    store.put("workers", value, orchestrator.id); return value;
  };
  const implementation = worker("implementation-context", "implementer");
  const standards = worker("standards-context", "standards");
  const spec = worker("spec-review-context", "spec");
  const automaticFix = worker("automatic-fix-context", "implementer", { rework_batch_id: "automatic-batch", review_origin: "automatic" });
  const humanFix = worker("human-fix-context", "implementer", { rework_batch_id: "human-batch", review_origin: "human" });
  for (const context of [interview, specification, orchestrator, human, implementation, standards, spec, automaticFix, humanFix]) {
    const isWorker = "run_id" in context;
    store.put("native_snapshots", { ...store.record(), id: `${context.id}-history`, run_id: isWorker ? context.run_id : context.id, worker_id: isWorker ? context.id : null, source_id: `native-${context.id}`, sequence: 0, version: "v1", cursor: null, turns: [{ role: "assistant", ts: "2026-01-01T00:00:00Z", parts: [{ kind: "text", text: `Retained ${context.id} decisions` }] }] }, isWorker ? context.run_id : context.id);
  }
  store.close();
  return { assignment, interview, specification, orchestrator, human, implementation, standards, spec, automaticFix, humanFix };
}
