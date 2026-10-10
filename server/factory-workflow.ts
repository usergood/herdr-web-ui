import type { FactoryApproval, FactoryQuestion, FactoryRun, FactoryTicket, Implementation, SpecificationVersion } from "../shared/protocol.ts";
import { isJsonObject } from "./http.ts";
import { FactoryError, hash } from "./factory-host.ts";
import { FactoryStore } from "./factory-store.ts";

/** Revision-scoped decisions. A new proposal never changes the contract of an existing Run. */
export class FactoryWorkflow {
  constructor(private readonly store: FactoryStore) {}
  specification(id: string): SpecificationVersion | null { return this.store.list<SpecificationVersion>("specifications", id).at(-1) ?? null; }
  tickets(id: string): FactoryTicket[] {
    const graph = this.store.get<{ id: string; specification_id: string; tickets: FactoryTicket[] }>("graphs", id);
    return graph && graph.specification_id === this.specification(id)?.id ? graph.tickets : [];
  }
  graphHash(id: string): string { return this.store.get<{ hash: string }>("graphs", id)?.hash ?? hash("[]"); }
  questionRevision(id: string): string { return hash(JSON.stringify(this.store.list("questions", id))); }
  approved(id: string, kind: FactoryApproval["kind"], revision: string): boolean {
    return this.store.list<FactoryApproval>("approvals", id).some((record) => record.kind === kind && record.revision === revision);
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
        const run = typeof body.run_id === "string" ? this.store.get<FactoryRun>("runs", body.run_id) : null;
        if (body.run_id !== undefined && (!run || run.implementation_id !== id)) throw new FactoryError("invalid_run", "Select this Implementation's Run");
        const question: FactoryQuestion = { ...this.store.record(), implementation_id: id, run_id: run?.id ?? null, question: body.question.trim(), answer: null, revision: this.store.record().id };
        this.store.put("questions", question, id); this.store.event(id, "question_asked", question);
        if (run) this.store.put("runs", { ...run, condition: "needs_you", waiting_reason: question.question }, id);
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
        const specification: SpecificationVersion = { ...this.store.record(), implementation_id: id, revision: (this.specification(id)?.revision ?? 0) + 1, content: body.content, hash: hash(body.content) };
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
      if (action === "approvals") {
        const kinds: FactoryApproval["kind"][] = ["specification", "testing_seams", "ticket_graph", "shared_understanding"];
        if (!kinds.includes(body.kind as FactoryApproval["kind"]) || typeof body.revision !== "string" || typeof body.scope !== "string" || !body.scope.trim() || body.scope.length > 20_000) throw new FactoryError("invalid_approval", "Accept an explicit revision and scope");
        const specification = this.specification(id);
        const revision = body.kind === "ticket_graph" ? this.graphHash(id) : body.kind === "shared_understanding" ? this.questionRevision(id) : specification?.id;
        if (!revision || body.revision !== revision || body.kind === "ticket_graph" && !this.tickets(id).length) throw new FactoryError("stale_approval", "This decision no longer matches the current revision", 409);
        if (body.kind === "shared_understanding" && this.store.list<FactoryQuestion>("questions", id).some((question) => question.answer === null)) throw new FactoryError("unanswered_questions", "Answer every pending question before confirming shared understanding", 409);
        const approval: FactoryApproval = { ...this.store.record(), implementation_id: id, kind: body.kind as FactoryApproval["kind"], revision: body.revision, scope: body.scope.trim() };
        this.store.put("approvals", approval, id); this.store.event(id, "owner_approved", approval);
        if (approval.kind === "ticket_graph" && !["running", "review"].includes(implementation.stage)) this.store.put("implementations", { ...implementation, stage: "ready", updated_at: approval.created_at });
        return approval;
      }
      throw new FactoryError("not_found", "Unknown workflow operation", 404);
    })();
  }
}
