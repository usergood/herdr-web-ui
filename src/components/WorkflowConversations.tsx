import { useEffect, useState, type ReactNode } from "react";
import type { FactoryConversation, FactoryConversationKind, FactoryNavigationConversation, FactoryCurrent, FactoryDetail } from "../../shared/factory.ts";
import type { Machine } from "../../shared/machines.ts";
import { factoryRead } from "../lib/factoryApi.ts";
import { useT } from "../lib/i18n.ts";
import { RetainedNativeTurn } from "./RetainedNativeTurn.tsx";
import { SpecificationConversation } from "./SpecificationConversation.tsx";
import "./WorkflowConversations.css";
import { HumanReviewConversation } from "./HumanReviewConversation.tsx";

function conversationLabel(kind: FactoryConversationKind, title: string | null, t: ReturnType<typeof useT>): string {
  switch (kind) {
    case "specifications": return t("Specifications");
    case "orchestrator": return t("Orchestrator");
    case "human_review": return t("Human Review");
    case "implementation": return t("Implementation: {title}", { title: title ?? "" });
    case "reviewer": return t("Reviewer");
    case "standards": return t("Standards");
    case "spec": return t("Spec");
    case "review_fixes": return t("Review-fixes");
  }
}

/** Reviewer is a display group; only its two independent contexts are navigable. */
export function WorkflowConversationTree({ conversations, selectedId, onSelect, renderContext }: { conversations: FactoryNavigationConversation[]; selectedId?: string | null; onSelect: (id: string) => void; renderContext?: (conversation: FactoryNavigationConversation) => ReactNode }) {
  const t = useT();
  const render = (parentId: string | null) => <ul className="workflow-conversation-tree">{conversations.filter(c => c.parent_id === parentId).map(c => <li key={c.id} data-conversation-kind={c.kind}>
    {c.kind === "reviewer" ? <span className="workflow-conversation-group">{conversationLabel(c.kind, c.title, t)}</span> : <button className="project-navigation-row" aria-current={selectedId === c.id ? "page" : undefined} onClick={() => onSelect(c.id)}>{conversationLabel(c.kind, c.title, t)}</button>}
    {renderContext?.(c)}
    {conversations.some(child => child.parent_id === c.id) && render(c.id)}
  </li>)}</ul>;
  return render(null);
}

export function WorkflowConversations({ detail, machines, selectedId, onSelect, onOpenPane, busy, perform }: { detail: FactoryCurrent; machines: Machine[]; selectedId?: string | null; onSelect: (id: string) => void; onOpenPane: (machineId: string, paneId: string) => void; busy: boolean; perform: (work: () => Promise<void>) => Promise<void> }) {
  const t = useT(); const conversations = detail.conversations ?? [];
  const selected = conversations.find(c => c.id === selectedId && c.kind !== "reviewer") ?? conversations.find(c => c.kind === "specifications");
  const [loaded, setLoaded] = useState<{ id: string; detail: FactoryDetail } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const id = selected?.id;
  const assignmentId = detail.implementation.id;
  useEffect(() => {
    if (!id) return;
    let live = true; setError(null);
    void factoryRead<FactoryDetail>(`/implementations/${encodeURIComponent(assignmentId)}?view=workflow&conversation_id=${encodeURIComponent(id)}&revision=${encodeURIComponent(detail.revision)}`)
      .then(next => { if (live) setLoaded({ id, detail: next }); })
      .catch(failure => { if (live) setError(failure.message); });
    return () => { live = false; };
  }, [assignmentId, id, detail.revision, retry]);
  if (!selected) return null;
  const retained = loaded?.id === selected.id ? loaded.detail : null;
  const selectedHistory = retained?.conversations?.find(conversation => conversation.id === selected.id) ?? selected;
  return <section className="factory-section workflow-conversations" aria-label={t("Workflow conversations")}>
    <h3>{t("Workflow conversations")}</h3>
    <nav aria-label={t("Workflow history")}><WorkflowConversationTree conversations={conversations} selectedId={selected.id} onSelect={onSelect} /></nav>
    {error && <p role="alert">{error} <button className="btn factory-button" onClick={() => setRetry(value => value + 1)}>{t("Retry")}</button></p>}
    {retained ? <ConversationHistory key={selected.id} detail={retained} selected={selectedHistory} machines={machines} busy={busy || !!error} perform={perform} onOpenPane={onOpenPane} /> : !error && <p role="status">{t("Loading…")}</p>}
  </section>;
}

/** A selected history body stays separate from the small pollable conversation tree. */
function ConversationHistory({ detail, selected, machines, busy, perform, onOpenPane }: { detail: FactoryDetail; selected: FactoryConversation; machines: Machine[]; busy: boolean; perform: (work: () => Promise<void>) => Promise<void>; onOpenPane: (machineId: string, paneId: string) => void }) {
  const t = useT();
  const snapshots = new Map(detail.native_snapshots.map(s => [s.id, s]));
  const specification = detail.specifications.at(-1);
  const history = selected.contexts.map(context => {
    const pane = machines.find(m => m.id === context.machine_id && m.state === "connected")?.snapshot?.panes.find(p => p.pane_id === context.pane_id && p.workspace_id === context.workspace_id && p.cwd === context.worktree);
    return <article className="factory-message" key={`${context.run_id}:${context.worker_id ?? "coordinator"}`}>
      <p>{context.action} · {context.condition} · {context.machine_id} · {context.provider}</p>
      <details><summary>{t("Native context")}</summary><p>{context.run_id}{context.worker_id && ` · ${context.worker_id}`}</p><p>{context.workspace_id} · {context.pane_id}</p><p>{context.worktree}</p></details>
      {context.pane_id && <button className="btn factory-button" disabled={!pane} onClick={() => onOpenPane(context.machine_id, context.pane_id!)}>{t("Open agent")}</button>}
      {!context.snapshot_ids.length && <p role="status">{t("Native history has not been retained.")}</p>}
      {context.snapshot_ids.map(id => {
        const snapshot = snapshots.get(id);
        return snapshot && <details key={id} open><summary>{snapshot.source_id} · {snapshot.sequence} · {new Date(snapshot.created_at).toLocaleString()}</summary>
          {snapshot.turns.map((turn, index) => <RetainedNativeTurn key={index} turn={turn} />)}
        </details>;
      })}
    </article>;
  });
  return <section className="workflow-conversation-history" aria-label={conversationLabel(selected.kind, selected.title, t)}>
      <h4>{conversationLabel(selected.kind, selected.title, t)}</h4>
      {selected.kind === "human_review" && <HumanReviewConversation detail={detail} busy={busy} perform={perform} history={history} />}
      {selected.kind === "specifications" && specification && <SpecificationConversation key={specification.id} detail={detail} specification={specification} busy={busy} perform={perform} />}
      {!selected.contexts.length && <p role="status">{t("No native context yet.")}</p>}
      {selected.kind !== "human_review" && history}
  </section>;
}
