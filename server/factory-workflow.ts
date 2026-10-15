import type { FactoryApproval, FactoryChat, FactoryMessage, FactoryQuestion, FactoryRun, FactoryTicket, FactoryWorker, Implementation, NativeConversationSnapshot, SpecificationVersion } from "../shared/protocol.ts";
import { isSpecificationAcceptance } from "../shared/specification-acceptance.ts";
import { isJsonObject } from "./http.ts";
import { FactoryError, hash } from "./factory-host.ts";
import { FactoryStore } from "./factory-store.ts";
import type { FactoryExecutionPlan, FactoryPlanningRequest, FactoryProject } from "../shared/factory.ts";

/** Revision-scoped decisions. A new proposal never changes the contract of an existing Run. */
export class FactoryWorkflow {
  constructor(private readonly store: FactoryStore) {}
  specification(id: string): SpecificationVersion | null { return this.store.list<SpecificationVersion>("specifications", id).at(-1) ?? null; }
  tickets(id: string): FactoryTicket[] {
    const graph = this.store.get<{ id: string; specification_id: string; tickets: FactoryTicket[] }>("graphs", id);
    return graph && graph.specification_id === this.specification(id)?.id ? graph.tickets : [];
  }
  graphHash(id: string): string { return this.store.get<{ hash: string }>("graphs", id)?.hash ?? hash("[]"); }
  /** Native setup probes belong to their own Run, rather than the product decision history. */
  questions(id: string, runId?: string): FactoryQuestion[] {
    const run = runId ? this.store.get<FactoryRun>("runs", runId) : null;
    return this.store.list<FactoryQuestion>("questions", id).filter(question => run?.action === "verify-provider"
      ? question.run_id === run.id
      : !question.run_id || this.store.get<FactoryRun>("runs", question.run_id)?.action !== "verify-provider");
  }
  questionRevision(id: string, runId?: string): string { return hash(JSON.stringify(this.questions(id, runId))); }
  approved(id: string, kind: FactoryApproval["kind"], revision: string): boolean {
    return this.store.list<FactoryApproval>("approvals", id).some((record) => record.kind === kind && record.revision === revision);
  }
  executionTickets(run: FactoryRun): FactoryTicket[] {
    const plan = this.store.get<FactoryExecutionPlan>("execution_plans", run.id);
    const manifest = run.manifest as { planning_authority?: FactoryApproval; tickets: FactoryTicket[] };
    return plan?.tickets ?? (manifest.planning_authority ? [] : manifest.tickets);
  }
  planningScope(id: string): string {
    const idea = this.store.get<Implementation>("implementations", id)!;
    const project = idea.project_id ? this.store.get<FactoryProject>("projects", idea.project_id) : null;
    const { updated_at: _updated, ...configuration } = project ?? {};
    return hash(JSON.stringify({ assignment: { title: idea.title, description: idea.description, project_id: idea.project_id, machine_id: idea.machine_id, provider: idea.provider }, project: configuration, checkouts: project ? this.store.list("checkouts", project.id) : [], specification: this.specification(id) }));
  }
  planningRequest(id: string, key: unknown): FactoryPlanningRequest | null {
    return this.store.list<FactoryPlanningRequest>("automatic_planning", id).find(request => key === `specification-${request.specification_id}`) ?? null;
  }
  private authorizePlanning(approval: FactoryApproval): void {
    this.store.put("automatic_planning", { ...this.store.record(), id: approval.id, implementation_id: approval.implementation_id, specification_id: approval.revision, approval_id: approval.id, scope_hash: this.planningScope(approval.implementation_id), condition: "pending", reason: null, run_id: null } satisfies FactoryPlanningRequest, approval.implementation_id);
  }
  plan(run: FactoryRun, body: Record<string, unknown>): FactoryExecutionPlan {
    return this.store.db.transaction(() => {
      const frozen = run.manifest as { planning_authority?: FactoryApproval; specification: SpecificationVersion; contract_hash: string };
      if (run.action !== "implement-spec" || !frozen.planning_authority?.automatic_execution || body.specification_id !== run.specification_id || frozen.specification.id !== run.specification_id) throw new FactoryError("scope_unaccepted", "Plan only this Run's accepted Specification", 409);
      const questions = this.questions(run.implementation_id, run.id);
      if (questions.some(q => q.answer === null) || questions.length && !this.store.list<{ revision: string; worker_id: string | null }>("answer_consumption", run.id).some(r => r.worker_id === null && r.revision === this.questionRevision(run.implementation_id, run.id))) throw new FactoryError("answers_unconsumed", "Consume the exact answered owner context before planning", 409);
      const signature = hash(JSON.stringify(body));
      const previous = this.store.get<FactoryExecutionPlan & { signature: string }>("execution_plans", run.id);
      if (previous) {
        if (previous.signature !== signature) throw new FactoryError("plan_frozen", "This Run already has a frozen execution plan; ask the owner about new scope", 409);
        return previous;
      }
      if (typeof body.testing_plan !== "string" || !body.testing_plan.trim() || body.testing_plan.length > 20_000) throw new FactoryError("invalid_testing_plan", "Retain a bounded testing plan within the accepted Specification");
      if (this.specification(run.implementation_id)?.id !== run.specification_id) throw new FactoryError("stale_specification", "The current Specification changed; retain the executing scope and ask the owner", 409);
      const graph = this.mutate(run.implementation_id, "tickets", body) as { hash: string; tickets: FactoryTicket[] };
      const plan = { ...this.store.record(), id: run.id, run_id: run.id, specification_id: frozen.specification.id, ...graph, testing_plan: body.testing_plan.trim(), authority: { kind: "specification" as const, approval_id: frozen.planning_authority.id, specification_id: frozen.specification.id, specification_hash: frozen.specification.hash, run_id: run.id, contract_hash: frozen.contract_hash }, signature };
      this.store.put("execution_plans", plan, run.implementation_id);
      this.store.event(run.implementation_id, "execution_plan_retained", { run_id: run.id, hash: plan.hash, authority: plan.authority });
      return plan;
    }).immediate();
  }
  /** Only a verified native page may supply an answer; ambiguous replies stay pending. */
  retainNativeAnswers(run: FactoryRun, snapshot: NativeConversationSnapshot, latestPage: boolean): void {
    if (!snapshot.worker_id) this.retainNativeAcceptance(run, snapshot, latestPage);
    const questions = this.store.list<FactoryQuestion>("questions", run.implementation_id)
      .filter(question => question.run_id === run.id && (question.worker_id ?? null) === (snapshot.worker_id ?? null)).sort((a, b) => a.created_at.localeCompare(b.created_at));
    // A chronological interval does not identify which overlapping question the
    // owner is answering. Keep every such reply pending for an explicit decision.
    if (questions.filter(question => question.answer === null && question.answer_kind !== "confirmation").length !== 1) return;
    const turns = snapshot.turns.filter(turn => turn.ts !== null && Number.isFinite(Date.parse(turn.ts)));
    const decisions = this.store.list<FactoryApproval>("approvals", run.implementation_id).filter(a => a.provenance?.kind === "native_chat" && a.provenance.run_id === run.id && a.provenance.source_id === snapshot.source_id);
    const userTurns = snapshot.turns.filter(turn => turn.role === "user" && !decisions.some(a => a.provenance?.turn_ts === turn.ts) && turn.parts.some(part => part.kind === "text") && turn.parts.every(part => part.kind === "text" || part.kind === "image"));
    if (userTurns.some(turn => turn.ts === null || !Number.isFinite(Date.parse(turn.ts)))) return;
    const oldest = turns.reduce((time, turn) => Math.min(time, Date.parse(turn.ts!)), Infinity);
    const newest = turns.reduce((time, turn) => Math.max(time, Date.parse(turn.ts!)), -Infinity);
    for (const [index, question] of questions.entries()) {
      if (question.answer !== null || question.answer_kind === "confirmation") continue;
      const start = Date.parse(question.created_at);
      const end = questions[index + 1] ? Date.parse(questions[index + 1]!.created_at) : Infinity;
      // A page must cover the whole question interval, not just one of several replies.
      if (!Number.isFinite(start) || end <= start || questions[index - 1]?.created_at === question.created_at || snapshot.cursor && oldest > start || !latestPage && newest < end) continue;
      const replies = userTurns.filter(turn => Date.parse(turn.ts!) > start && Date.parse(turn.ts!) < end);
      if (replies.length !== 1) continue;
      const reply = replies[0]!;
      const answer = reply.parts.flatMap(part => part.kind === "text" ? [part.text] : []).join("\n").trim();
      if (!answer || answer.length > 20_000) continue;
      this.mutate(run.implementation_id, "answer", { question_id: question.id, revision: question.revision, answer });
      this.store.event(run.implementation_id, "native_question_answered", { question_id: question.id, run_id: run.id, snapshot_id: snapshot.id, source_id: snapshot.source_id, turn_ts: reply.ts });
    }
  }
  private retainNativeAcceptance(run: FactoryRun, snapshot: NativeConversationSnapshot, latestPage: boolean): void {
    const spec = this.specification(run.implementation_id);
    if (!latestPage || run.action !== "to-spec" || spec?.presentation_run_id !== run.id || this.approved(run.implementation_id, "specification", spec.id)) return;
    const presentation = `Specification ${spec.id}, SHA-256 ${spec.hash}\n\n${spec.content}`.trim();
    for (const [index, reply] of snapshot.turns.entries()) {
      const previous = snapshot.turns[index - 1];
      const finalPart = previous?.parts.at(-1);
      if (!previous || previous.role !== "assistant" || reply.role !== "user" || finalPart?.kind !== "text" || !reply.parts.every(p => p.kind === "text")) continue;
      const shown = finalPart.text.trim();
      const answer = reply.parts.flatMap(p => p.kind === "text" ? [p.text] : []).join("\n").trim();
      const presentedAt = previous.end_ts ?? previous.ts;
      if (shown !== presentation || !isSpecificationAcceptance(answer) || !presentedAt || !reply.ts || !Number.isFinite(Date.parse(presentedAt)) || !Number.isFinite(Date.parse(reply.ts)) || Date.parse(presentedAt) < Date.parse(spec.created_at) || Date.parse(reply.ts) <= Date.parse(presentedAt)) continue;
      if (this.questions(run.implementation_id).some(q => q.answer === null && Date.parse(q.created_at) >= Date.parse(presentedAt) && Date.parse(q.created_at) <= Date.parse(reply.ts!))) continue;
      const approval: FactoryApproval = { ...this.store.record(), implementation_id: run.implementation_id, kind: "specification", automatic_execution: true, revision: spec.id, scope: `Specification ${spec.id}, SHA-256 ${spec.hash}`, provenance: { kind: "native_chat", specification_hash: spec.hash, run_id: run.id, snapshot_id: snapshot.id, source_id: snapshot.source_id, turn_ts: reply.ts } };
      this.store.put("approvals", approval, run.implementation_id); this.authorizePlanning(approval); this.store.event(run.implementation_id, "owner_approved", approval);
      return;
    }
  }
  mutate(id: string, action: string, body: Record<string, unknown>): unknown {
    return this.store.db.transaction(() => {
      const implementation = this.store.get<Implementation>("implementations", id);
      if (!implementation) throw new FactoryError("not_found", "Implementation not found", 404);
      if (action === "order") {
        const ordered = this.store.list<Implementation>("implementations").sort((a, b) => a.position - b.position);
        const from = ordered.findIndex((item) => item.id === id);
        if (typeof body.before_id === "string") {
          if (body.before_id === id) return { ok: true };
          const to = ordered.findIndex((item) => item.id === body.before_id);
          if (to < 0) throw new FactoryError("invalid_order", "Select an existing destination card");
          const [item] = ordered.splice(from, 1); ordered.splice(ordered.findIndex((entry) => entry.id === body.before_id), 0, item!);
        } else {
          if (body.direction !== -1 && body.direction !== 1) throw new FactoryError("invalid_order", "Move one position earlier or later");
          const to = from + body.direction;
          if (to >= 0 && to < ordered.length) [ordered[from], ordered[to]] = [ordered[to]!, ordered[from]!];
        }
        ordered.forEach((item, position) => this.store.put("implementations", { ...item, position }));
        this.store.event(id, "board_reordered", { direction: body.direction }); return { ok: true };
      }
      if (action === "questions") {
        if (typeof body.question !== "string" || !body.question.trim() || body.question.length > 20_000) throw new FactoryError("invalid_question", "Enter a bounded owner question");
        if (body.answer_kind !== undefined && body.answer_kind !== "text" && body.answer_kind !== "confirmation") throw new FactoryError("invalid_question", "Choose a text answer or shared-understanding confirmation");
        const run = typeof body.run_id === "string" ? this.store.get<FactoryRun>("runs", body.run_id) : null;
        if (body.run_id !== undefined && (!run || run.implementation_id !== id)) throw new FactoryError("invalid_run", "Select this Implementation's Run");
        const worker = typeof body.worker_id === "string" ? this.store.get<FactoryWorker>("workers", body.worker_id) : null;
        if (body.worker_id !== undefined && (!worker || worker.run_id !== run?.id || ["completed", "cancelled", "failed"].includes(worker.condition))) throw new FactoryError("invalid_worker", "Select an owned active worker for this question", 409);
        const question: FactoryQuestion = { ...this.store.record(), implementation_id: id, run_id: run?.id ?? null, ...(worker ? { worker_id: worker.id } : {}), question: body.question.trim(), ...(body.answer_kind === undefined ? {} : { answer_kind: body.answer_kind }), answer: null, revision: this.store.record().id };
        this.store.put("questions", question, id); this.store.event(id, "question_asked", question);
        if (worker) this.store.put("workers", { ...worker, condition: "needs_you", continuation: { ...this.store.record(), kind: "owner", condition: "parking", reason: "Waiting for verified native rest before releasing capacity", question_revision: null } }, run!.id);
        else if (run) this.store.put("runs", { ...run, condition: "needs_you", waiting_reason: question.question, continuation: { ...this.store.record(), kind: "owner", condition: "parking", reason: "Waiting for verified native rest before releasing capacity", question_revision: null } }, id);
        return question;
      }
      if (action === "answer") {
        const question = typeof body.question_id === "string" ? this.store.get<FactoryQuestion>("questions", body.question_id) : null;
        if (!question || question.implementation_id !== id) throw new FactoryError("invalid_question", "Select this Implementation's question");
        if (body.revision !== question.revision || question.answer !== null) throw new FactoryError("stale_question", "This asking was changed or already answered", 409);
        if (typeof body.answer !== "string" || !body.answer.trim() || body.answer.length > 20_000) throw new FactoryError("invalid_answer", "Enter your answer");
        const answered = { ...question, answer: body.answer.trim(), updated_at: new Date().toISOString() };
        this.store.put("questions", answered, id); this.store.event(id, "owner_answered", answered); return answered;
      }
      if (action === "specifications") {
        if (typeof body.content !== "string" || !body.content.trim() || body.content.length > 250_000) throw new FactoryError("invalid_specification", "Enter a bounded specification");
        const specification: SpecificationVersion = { ...this.store.record(), implementation_id: id, revision: (this.specification(id)?.revision ?? 0) + 1, content: body.content, hash: hash(body.content), ...(typeof body.presentation_run_id === "string" ? { presentation_run_id: body.presentation_run_id } : {}) };
        this.store.put("specifications", specification, id);
        if (!["running", "review"].includes(implementation.stage)) this.store.put("implementations", { ...implementation, stage: "specifying", updated_at: specification.created_at });
        this.store.event(id, "specification_created", { specification_id: specification.id, revision: specification.revision });
        return specification;
      }
      if (action === "tickets") {
        const specification = this.specification(id);
        if (!specification || body.specification_id !== specification.id) throw new FactoryError("stale_specification", "Select the latest specification revision", 409);
        if (!this.approved(id, "specification", specification.id)) throw new FactoryError("specification_unaccepted", "Accept this specification before planning Tickets", 409);
        if (!Array.isArray(body.tickets) || body.tickets.length === 0 || body.tickets.length > 100) throw new FactoryError("invalid_tickets", "Plan between one and 100 Tickets");
        const keys = new Map<string, string>();
        for (const ticket of body.tickets) {
          if (!isJsonObject(ticket) || typeof ticket.key !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(ticket.key) || keys.has(ticket.key) || typeof ticket.title !== "string" || !ticket.title.trim() || ticket.title.length > 200 || typeof ticket.acceptance !== "string" || !ticket.acceptance.trim() || ticket.acceptance.length > 20_000 || !Array.isArray(ticket.dependencies) || ticket.dependencies.some((dependency: unknown) => typeof dependency !== "string")) throw new FactoryError("invalid_tickets", "Each Ticket needs a unique key, title, acceptance criteria and dependency keys");
          keys.set(ticket.key, this.store.record().id);
        }
        const planned = body.tickets as Record<string, unknown>[];
        const visiting = new Set<string>(); const visited = new Set<string>();
        const visit = (key: string): void => {
          if (visiting.has(key)) throw new FactoryError("cyclic_graph", "Ticket dependencies must not contain a cycle");
          if (visited.has(key)) return;
          const ticket = planned.find((record) => record.key === key);
          if (!ticket) throw new FactoryError("missing_dependency", "A Ticket dependency is missing from this graph");
          visiting.add(key);
          for (const dependency of ticket.dependencies as string[]) visit(dependency);
          visiting.delete(key); visited.add(key);
        };
        for (const key of keys.keys()) visit(key);
        const tickets: FactoryTicket[] = planned.map((ticket) => ({ ...this.store.record(), id: keys.get(ticket.key as string)!, implementation_id: id, specification_id: specification.id, title: ticket.title as string, acceptance: ticket.acceptance as string, dependencies: [...new Set(ticket.dependencies as string[])].map((key) => keys.get(key)!), status: "proposed", tracker_reference: null }));
        const graphHash = hash(JSON.stringify(tickets));
        this.store.put("graphs", { id, specification_id: specification.id, hash: graphHash, tickets }, id);
        this.store.put("graph_versions", { ...this.store.record(), specification_id: specification.id, hash: graphHash, tickets }, id);
        this.store.event(id, "tickets_proposed", { specification_id: specification.id, graph_hash: graphHash, tickets });
        return { hash: graphHash, tickets };
      }
      if (action === "specification-acceptance") {
        const specification = this.specification(id);
        if (!specification || body.specification_id !== specification.id || body.hash !== specification.hash) throw new FactoryError("stale_specification", "Accept the presented current Specification revision", 409);
        if (body.source !== "button" && body.source !== "owner_chat" || body.role !== undefined || body.source_id !== undefined) throw new FactoryError("invalid_acceptance", "Choose an explicit owner acceptance");
        if (body.source === "owner_chat") {
          if (typeof body.content !== "string" || !body.content.trim() || body.content.length > 20_000 || typeof body.idempotency_key !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(body.idempotency_key)) throw new FactoryError("invalid_acceptance", "Send a bounded owner reply with a stable identity");
          const sourceId = `specification:${specification.id}:${body.idempotency_key}`;
          let message = this.store.list<FactoryMessage>("messages", id).find(m => m.source_id === sourceId);
          if (message && (message.content !== body.content.trim() || message.role !== "owner" || !this.store.list<FactoryChat>("chats", id).some(c => c.id === message?.chat_id && c.title === "Specifications"))) throw new FactoryError("source_conflict", "This reply identity already has different content or provenance", 409);
          if (!message) {
            const chat = this.store.list<FactoryChat>("chats", id).find(c => c.title === "Specifications") ?? this.store.put("chats", { ...this.store.record(), implementation_id: id, title: "Specifications" }, id);
            message = { ...this.store.record(), implementation_id: id, chat_id: chat.id, role: "owner", content: body.content.trim(), source_id: sourceId, sequence: 0 };
            this.store.put("messages", message, id); this.store.event(id, "message_retained", { message_id: message.id, chat_id: chat.id });
          }
          let approval = this.store.list<FactoryApproval>("approvals", id).find(a => a.kind === "specification" && a.revision === specification.id) ?? null;
          if (!approval && isSpecificationAcceptance(message.content)) {
            approval = { ...this.store.record(), implementation_id: id, kind: "specification", automatic_execution: true, revision: specification.id, scope: `Specification ${specification.id}, SHA-256 ${specification.hash}`, provenance: { kind: "owner_chat", specification_hash: specification.hash, message_id: message.id } };
            this.store.put("approvals", approval, id); this.authorizePlanning(approval); this.store.event(id, "owner_approved", approval);
          }
          return { message, approval };
        }
        const previous = this.store.list<FactoryApproval>("approvals", id).find(a => a.kind === "specification" && a.revision === specification.id);
        if (previous) return previous;
        const approval: FactoryApproval = { ...this.store.record(), implementation_id: id, kind: "specification", automatic_execution: true, revision: specification.id, scope: `Specification ${specification.id}, SHA-256 ${specification.hash}`, provenance: { kind: "button", specification_hash: specification.hash } };
        this.store.put("approvals", approval, id); this.authorizePlanning(approval); this.store.event(id, "owner_approved", approval);
        return approval;
      }
      if (action === "approvals") {
        const kinds: FactoryApproval["kind"][] = ["specification", "testing_seams", "ticket_graph", "shared_understanding"];
        if (!kinds.includes(body.kind as FactoryApproval["kind"]) || typeof body.revision !== "string" || typeof body.scope !== "string" || !body.scope.trim() || body.scope.length > 20_000) throw new FactoryError("invalid_approval", "Accept an explicit revision and scope");
        const specification = this.specification(id);
        let revision = body.kind === "ticket_graph" ? this.graphHash(id) : body.kind === "shared_understanding" ? this.questionRevision(id) : specification?.id;
        if (!revision || body.revision !== revision || body.kind === "ticket_graph" && !this.tickets(id).length) throw new FactoryError("stale_approval", "This decision no longer matches the current revision", 409);
        if (body.kind === "shared_understanding") {
          const pending = this.questions(id).filter(question => question.answer === null);
          if (pending.some(question => question.answer_kind !== "confirmation")) throw new FactoryError("unanswered_questions", "Answer every pending question before confirming shared understanding", 409);
          for (const question of pending) this.mutate(id, "answer", { question_id: question.id, revision: question.revision, answer: "Confirmed" });
          revision = this.questionRevision(id);
        }
        const approval: FactoryApproval = { ...this.store.record(), implementation_id: id, kind: body.kind as FactoryApproval["kind"], revision, scope: body.scope.trim() };
        this.store.put("approvals", approval, id); this.store.event(id, "owner_approved", approval);
        if (approval.kind === "ticket_graph" && !["running", "review"].includes(implementation.stage)) this.store.put("implementations", { ...implementation, stage: "ready", updated_at: approval.created_at });
        return approval;
      }
      throw new FactoryError("not_found", "Unknown workflow operation", 404);
    })();
  }
}
