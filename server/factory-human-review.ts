import type { FactoryChat, FactoryMessage, FactoryHumanReview as HumanReview, FactoryPullRequest, FactoryRun, Implementation } from "../shared/factory.ts";
import { FactoryError } from "./factory-host.ts";
import type { FactoryReview } from "./factory-review.ts";
import type { FactoryRuntime } from "./factory-runtime.ts";
import type { FactoryStore } from "./factory-store.ts";

/** Reading a captured candidate is independent of native agent admission. */
export class FactoryHumanReview {
  constructor(private readonly store: FactoryStore, private readonly runtime: FactoryRuntime, private readonly review: FactoryReview, private readonly retain: (id: string) => Promise<unknown>) {
    for (const request of store.list<import("../shared/factory.ts").FactoryHumanReviewDelivery>("human_review_messages")) if (request.condition === "sending") {
      const message = store.get<FactoryMessage>("messages", request.id);
      if (message) store.put("human_review_messages", { ...request, condition: "uncertain", reason: "Discussion delivery was not confirmed; inspect the retained native conversation before sending again" }, message.implementation_id);
    }
    runtime.queue.discuss = (id, body) => this.deliver(id, String(body.message_id));
  }
  async discuss(id: string, body: Record<string, unknown>, origin: string): Promise<FactoryMessage> {
    this.runtime.assertExecuting(id);
    const entry = typeof body.review_id === "string" ? this.store.get<HumanReview>("human_reviews", body.review_id) : null;
    if (!entry || entry.implementation_id !== id || entry.condition !== "ready") throw new FactoryError("review_unavailable", "Select this Assignment's captured Human Review", 409);
    if (typeof body.content !== "string" || !body.content.trim() || body.content.length > 20000 || typeof body.idempotency_key !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(body.idempotency_key)) throw new FactoryError("invalid_message", "Enter a bounded discussion message and request identity");
    const source = `human-review:${body.idempotency_key}`;
    let message = this.store.list<FactoryMessage>("messages", id).find(m => m.source_id === source);
    if (message) {
      if (message.content !== body.content.trim()) throw new FactoryError("message_conflict", "This message identity has different content", 409);
      return message;
    }
    const chat = this.store.list<FactoryChat>("chats", id).find(c => c.title === "Human Review") ?? { ...this.store.record(), implementation_id: id, title: "Human Review" };
    message = { ...this.store.record(), implementation_id: id, chat_id: chat.id, role: "owner", content: body.content.trim(), source_id: source, sequence: null };
    const parent = this.store.get<FactoryRun>("runs", entry.run_id)!;
    const idea = this.store.get<Implementation>("implementations", id)!;
    this.store.db.transaction(() => {
      this.store.put("chats", chat, id); this.store.put("messages", message!, id);
      this.store.put("human_review_messages", { id: message!.id, review_id: entry.id, condition: "queued", reason: null, origin }, id);
      this.runtime.queue.enqueueContinuation({ ...message!, id: `discussion:${message!.id}`, assignment_title: idea.title, action: "work", machine_id: parent.machine_id, provider: parent.provider, idempotency_key: message!.id, purpose: "execution", condition: "queued", run_id: parent.id, continuation: true, reason: "Waiting for normal agent capacity for Human Review" }, { human_review: true, message_id: message!.id });
    }).immediate();
    return message;
  }
  private async deliver(id: string, messageId: string): Promise<void> {
    const request = this.store.get<{ id: string; review_id: string; condition: string; origin: string }>("human_review_messages", messageId);
    if (!request || request.condition !== "queued") return;
    const entry = this.store.get<HumanReview>("human_reviews", request.review_id)!;
    const parent = this.store.get<FactoryRun>("runs", id)!;
    const message = this.store.get<FactoryMessage>("messages", messageId)!;
    this.runtime.assertExecuting(parent.implementation_id);
    const assistant = entry.assistant_run_id ? this.store.get<FactoryRun>("runs", entry.assistant_run_id) : null;
    if (assistant && !["ready", "completed", "cancelled", "failed"].includes(assistant.condition)) throw new FactoryError("continuation_waiting", assistant.waiting_reason ?? "Waiting for the Human Review assistant to finish its current turn", 409);
    let claimed = false;
    try {
      const run = await this.runtime.discussReview(parent, entry, message, request.origin, () => { claimed = true; this.store.put("human_review_messages", { ...request, condition: "sending", reason: null }, parent.implementation_id); });
      this.store.put("human_reviews", { ...entry, assistant_run_id: run.id }, parent.implementation_id);
      this.store.put("human_review_messages", { ...request, condition: ["working", "ready"].includes(run.condition) ? "sent" : "uncertain", reason: ["working", "ready"].includes(run.condition) ? null : "Discussion delivery was not confirmed; inspect the retained native conversation before sending again" }, parent.implementation_id);
    } catch (error) {
      if (!claimed) throw error;
      this.store.put("human_review_messages", { ...request, condition: "uncertain", reason: "Discussion delivery was not confirmed; inspect the retained native conversation before sending again" }, parent.implementation_id);
    }
  }
  async retainAssistant(run: FactoryRun): Promise<void> {
    if (run.conversation_kind === "human_review" && run.condition === "ready") await this.retain(run.id);
  }
  async handoff(run: FactoryRun): Promise<void> {
    const existing = this.store.get<HumanReview>("human_reviews", run.id);
    if (existing && ["ready", "blocked"].includes(existing.condition)) return;
    const pr = this.store.get<FactoryPullRequest>("pull_requests", run.id);
    if (!pr) return;
    let entry: HumanReview = existing ?? { ...this.store.record(), id: run.id, implementation_id: run.implementation_id, run_id: run.id, conversation_id: `${run.implementation_id}:human_review`, head: pr.head, snapshot_id: null, assistant_run_id: null, condition: "capturing", reason: null };
    this.store.put("human_reviews", entry, run.implementation_id);
    try {
      const current = await this.runtime.reconcile(run.id);
      if (current.condition !== "ready") throw new FactoryError("review_waiting", current.waiting_reason ?? "Waiting for Orchestrator to reach verified native rest", 409);
      const snapshot = await this.review.capture(run.implementation_id, { run_id: run.id, mode: "branch" });
      if (snapshot.head !== pr.head) throw new FactoryError("review_stale", "The captured candidate differs from the checked PR head", 409);
      this.runtime.assertExecuting(run.implementation_id);
      this.store.db.transaction(() => {
        entry = { ...entry, snapshot_id: snapshot.id, condition: "ready", reason: null };
        this.store.put("human_reviews", entry, run.implementation_id);
        this.store.event(run.implementation_id, "human_review_handoff", { run_id: run.id, snapshot_id: snapshot.id, head: pr.head, conversation_id: entry.conversation_id });
      }).immediate();
    } catch (error) {
      this.store.put("human_reviews", { ...entry, condition: error instanceof FactoryError && error.code === "review_stale" ? "blocked" : "waiting", reason: error instanceof FactoryError ? error.message : "The execution Machine is unavailable; captured review will resume when it reconnects" }, run.implementation_id);
    }
  }
}
