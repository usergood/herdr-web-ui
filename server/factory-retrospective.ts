import type { FactoryProject, FactoryRetrospective, Implementation } from "../shared/protocol.ts";
import { FactoryError, hash } from "./factory-host.ts";
import { FactoryStore } from "./factory-store.ts";

/** Only selected application evidence enters a retrospective; proposals never apply themselves. */
export class FactoryRetrospectives {
  constructor(private readonly store: FactoryStore) {}
  create(projectId: string, body: Record<string, unknown>): FactoryRetrospective {
    if (!this.store.get<FactoryProject>("projects", projectId)) throw new FactoryError("not_found", "Project not found", 404);
    if (!Array.isArray(body.evidence_ids) || !body.evidence_ids.length || body.evidence_ids.length > 200 || body.evidence_ids.some((id: unknown) => typeof id !== "string") || typeof body.proposal !== "string" || body.proposal.length > 100_000) throw new FactoryError("invalid_retrospective", "Select bounded Project evidence and an optional proposal");
    const implementations = this.store.list<Implementation>("implementations").filter((entry) => entry.project_id === projectId);
    const owned = new Set(implementations.map((entry) => entry.id));
    const runs = new Set(this.store.list<{ id: string; implementation_id: string }>("runs").filter((entry) => owned.has(entry.implementation_id)).map((entry) => entry.id));
    const evidence = ["runs", "messages", "artifacts", "snapshots", "events", "specifications", "comments", "checks", "review_evidence", "native_snapshots"].flatMap((kind) => this.store.list<{ id: string; implementation_id?: string; run_id?: string }>(kind).filter((entry) => owned.has(entry.implementation_id ?? "") || runs.has(entry.run_id ?? "")));
    const ids = [...new Set(body.evidence_ids as string[])];
    const selected = ids.map((id) => evidence.find((entry) => entry.id === id));
    if (selected.some((entry) => !entry)) throw new FactoryError("invalid_evidence_scope", "Select evidence retained for this Project; unrelated native sessions are unavailable");
    const record: FactoryRetrospective = { ...this.store.record(), project_id: projectId, evidence_ids: ids, scope_hash: hash(JSON.stringify(selected)), proposal: body.proposal, approved: false, applied_run_id: null };
    this.store.db.transaction(() => { this.store.put("retrospectives", record, projectId); this.store.put("retro_evidence", { id: record.id, records: selected }, projectId); this.store.event(null, "retrospective_proposed", { retrospective_id: record.id, project_id: projectId, scope_hash: record.scope_hash }); })(); return record;
  }
  approve(id: string, body: Record<string, unknown>): FactoryRetrospective {
    const record = this.store.get<FactoryRetrospective>("retrospectives", id);
    if (!record) throw new FactoryError("not_found", "Retrospective not found", 404);
    if (body.scope_hash !== record.scope_hash || !record.proposal.trim()) throw new FactoryError("retrospective_stale", "Accept the exact scoped proposal with retained evidence", 409);
    const next = { ...record, approved: true, updated_at: new Date().toISOString() };
    this.store.put("retrospectives", next, record.project_id); this.store.event(null, "retrospective_approved", { retrospective_id: id }); return next;
  }
  propose(id: string, body: Record<string, unknown>): FactoryRetrospective {
    const scope = this.store.get<FactoryRetrospective>("retrospectives", id);
    if (!scope || typeof body.proposal !== "string" || !body.proposal.trim() || body.proposal.length > 100_000) throw new FactoryError("invalid_proposal", "Present bounded candidates for the retained evidence scope");
    const candidate = { ...scope, ...this.store.record(), proposal: body.proposal, approved: false, applied_run_id: null };
    this.store.put("retrospectives", candidate, scope.project_id);
    this.store.put("retro_evidence", { ...this.store.get<{ id: string; records: unknown[] }>("retro_evidence", id)!, id: candidate.id }, scope.project_id);
    this.store.event(null, "retrospective_candidates_retained", { retrospective_id: candidate.id, scope_id: id }); return candidate;
  }
}
