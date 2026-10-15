import { useEffect, useRef, useState } from "react";
import { MessageSquare, Play, ListChecks } from "lucide-react";
import type { FactoryAction, FactoryCapabilities, FactoryCapacityWait, FactoryDetail, FactoryProject, FactoryProvider, FactoryRun } from "../../shared/protocol.ts";
import { factoryDetail, factoryRequest } from "../lib/factoryApi.ts";
import { useT } from "../lib/i18n.ts";
import { Markdown } from "./Markdown.tsx";
import "./AssignmentActions.css";
import { AgentModelPicker } from "./AgentModelPicker.tsx";
import type { AgentExecutionPreset, AgentModelSelection } from "../../shared/agent-models.ts";

export function AssignmentActions({ preset, onPresetChange, detail, project, machineId, machineName, provider, busy, perform, onOpenPane, capabilities, problem, onCapabilities }: { preset: AgentModelSelection; onPresetChange: (value: AgentModelSelection) => void; detail: FactoryDetail; project?: FactoryProject; machineId: string; machineName: string; provider: FactoryProvider; busy: boolean; perform: (action: () => Promise<void>) => Promise<void>; onOpenPane: (machineId: string, paneId: string) => void; capabilities: FactoryCapabilities | null; problem: string | null; onCapabilities: (value: FactoryCapabilities) => void }) {
  const t = useT(); const live = useRef(true);
  const prefix = `/implementations/${detail.implementation.id}`;
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const capability = capabilities?.providers.find(entry => entry.provider === provider);
  const active = [...detail.runs].reverse().find(run => ["accepted", "working", "ready", "needs_you", "blocked", "disconnected", "interrupted"].includes(run.condition));
  const queued = detail.capacity_waiting?.some(wait => wait.condition === "queued");
  const unconfirmedWork = active?.action === "work" && ["interrupted", "disconnected"].includes(active.condition);
  const specification = detail.specifications.at(-1);
  const approved = (kind: string, revision: string) => detail.approvals.some(a => a.kind === kind && a.revision === revision);
  const specReady = !!specification && approved("specification", specification.id) && approved("testing_seams", specification.id);
  const questions = detail.question_context?.questions ?? detail.questions;
  const questionRevision = detail.question_context?.revision ?? detail.question_revision;
  const understood = !questions.length || questions.every(q => q.answer !== null) && approved("shared_understanding", detail.question_revision);
  const discussed = detail.runs.some(run => run.action === "grill-with-docs" || run.action === "grill-me");
  const verification = [...detail.runs].reverse().find(run => run.action === "verify-provider");
  const latest = detail.runs.at(-1);
  const waitingEvent = detail.events.filter(event => event.kind === "continuation_waiting" && (event.data as { run_id?: string } | null)?.run_id === (active?.id ?? latest?.id)).at(-1);
  const continuationProblem = (waitingEvent?.data as { message?: string } | undefined)?.message;
  const lastHandoffEvent = (kinds: string[]) => latest && detail.events.filter(event => kinds.includes(event.kind) && (event.data as { run_id?: string }).run_id === latest.id).at(-1)?.kind;
  const handoffProblem = lastHandoffEvent(["native_snapshot_unavailable", "planning_handoff_retained"]) === "native_snapshot_unavailable" || lastHandoffEvent(["planning_documents_unavailable", "planning_documents_retained"]) === "planning_documents_unavailable";
  const [acknowledgedHandoff, setAcknowledgedHandoff] = useState<string | null>(null);
  const incompleteHandoff = handoffProblem && acknowledgedHandoff !== latest?.id;
  const check = active ? detail.checks.filter(c=>c.run_id===active.id&&c.worker_id===null).at(-1) : undefined;
  const suggestedAction: FactoryAction | null = detail.tickets.length && approved("ticket_graph", detail.graph_hash) ? "implement-spec" : specReady ? "to-tickets" : !specification && discussed && understood ? "to-spec" : null;
  const nextAction = suggestedAction === active?.action ? null : suggestedAction;
  async function launch(action: FactoryAction) {
      if (!capability?.skills_verified) await factoryRequest(`/machines/${encodeURIComponent(machineId)}/prepare`, {});
      const run = await factoryRequest<FactoryRun | FactoryCapacityWait>(prefix + (action === "work" ? "/runs" : "/continue"), { ...(action === "work" ? {} : { run_id: active?.id ?? null, allow_partial_handoff: acknowledgedHandoff === active?.id }), action, execution_preset: preset, idempotency_key: crypto.randomUUID(), expected: { provider, machine_id: machineId, project_id: detail.implementation.project_id, specification_id: specification?.id ?? null, graph_hash: detail.graph_hash } });
      if (!live.current) return;
      if (run.condition === "queued" || !("pane_id" in run)) return;
      if (run.condition !== "working" || !run.pane_id) throw new Error(run.waiting_reason ?? t("The agent did not start. Open advanced controls to inspect the retained attempt."));
      onOpenPane(run.machine_id, run.pane_id);
  }
  async function start(action: FactoryAction) { await perform(() => launch(action)); }
  async function approve(kind: "shared_understanding" | "specification" | "testing_seams" | "ticket_graph", revision: string, scope: string) {
    await perform(async () => {
      await factoryRequest(prefix + "/approvals", { kind, revision, scope });
      const updated = await factoryDetail(detail.implementation.id);
      const spec = updated.specifications.at(-1);
      const accepted = (approvalKind: string, version: string) => updated.approvals.some(a => a.kind === approvalKind && a.revision === version);
      if (kind === "shared_understanding" && !spec) await launch("to-spec");
      else if (kind === "ticket_graph") await launch("implement-spec");
      else if (spec && !updated.tickets.length && accepted("specification", spec.id) && accepted("testing_seams", spec.id)) await launch("to-tickets");
    });
  }
  const disabled = busy || queued || !project || !!project.removed_at || !!detail.implementation.archived_at || !capability?.installed;
  return <section className="assignment-actions factory-section" aria-label={t("Next step")}>
    <p role="status">{project ? t("Work uses {agent} on {machine} with this Project's settings.", { agent: provider, machine: machineName }) : t("Choose a Project to start work or plan implementation.")}</p>
    {queued && <p role="status">{t("Queued work starts automatically when capacity is available.")}</p>}
    {detail.capacity_waiting?.filter(wait => wait.condition === "blocked").map(wait => <p role="alert" key={wait.id}>{wait.reason}</p>)}
    {problem && <p role="alert">{problem}</p>}
    {continuationProblem && <p role="alert">{continuationProblem}</p>}
    {!active && project && <AgentModelPicker projectId={project.id} machineId={machineId} provider={provider} accountScope={JSON.stringify(project.account_bindings?.[machineId] ?? {})} value={preset} onChange={onPresetChange} disabled={busy} />}
    {active && <p>{t("Launch model")} · {(active.manifest as { execution_preset?: AgentExecutionPreset }).execution_preset?.model ?? t("Use CLI default")} · {t("Launch reasoning")} · {(active.manifest as { execution_preset?: AgentExecutionPreset }).execution_preset?.reasoning ?? t("Use model default")}</p>}
    {handoffProblem && <div><p role="alert">{t("Some planning context could not be retained. Check the previous agent chat and documents before starting the next step.")}</p>{incompleteHandoff && <button className="btn" disabled={busy} onClick={() => setAcknowledgedHandoff(latest?.id ?? null)}>{t("Continue with available context")}</button>}</div>}
    {project && !capability?.installed && capabilities && <p role="status">{t("Install or sign in to this Project's agent on its Machine, then try again.")}</p>}
    {active ? <div className="factory-actions">
      {unconfirmedWork && active.waiting_reason && <p role="alert">{active.waiting_reason}</p>}
      <button className="btn btn-primary" disabled={busy || !active.pane_id} onClick={() => active.pane_id && onOpenPane(active.machine_id, active.pane_id)}><MessageSquare />{t("Continue in agent chat")}</button>
      {active.action !== "implement-spec" && nextAction && <button className="btn btn-primary" disabled={busy || incompleteHandoff || ["disconnected", "interrupted"].includes(active.condition)} onClick={() => void start(nextAction)}>{t("Continue workflow")}</button>}
      {active.action==="implement-spec" ? <button className="btn" disabled={busy||check?.condition!=="passed"} onClick={()=>void perform(async()=>{await factoryRequest(`/runs/${active.id}/accept`,{head:check?.head??""});})}>{t("Accept reviewed head")}</button> : active.action === "work" ? <button className="btn" disabled={busy} onClick={() => void perform(async () => { if(active.action==="work"&&!unconfirmedWork)await factoryRequest(prefix+"/complete-work",{run_id:active.id});else await factoryRequest(`/runs/${active.id}/stop`, { summary: unconfirmedWork ? "Owner stopped an unconfirmed work attempt; retained work remains available" : "Owner finished this workflow step; retained work remains available" }); })}>{unconfirmedWork?t("Stop this attempt"):active.action==="work"?t("Mark work done"):t("Finish this step")}</button> : null}
      {active.action==="implement-spec" && detail.review_evidence.filter(r=>r.run_id===active.id).map(r=><details key={r.id}><summary>{r.axis} · {r.outcome}</summary><pre>{r.content}</pre></details>)}
      <p className="field-hint">{unconfirmedWork?t("Stopping keeps the worktree. You can start a new attempt afterwards."):t("Review and continue from this chat. Finished steps keep their history.")}</p>
    </div> : <div className="factory-actions">
      <button className="btn btn-primary" disabled={disabled} onClick={() => void start("work")}><Play />{t("Start work")}</button>
      {!specification && <button className="btn" disabled={disabled} onClick={() => void start("grill-with-docs")}><ListChecks />{t("Plan implementation")}</button>}
      {!specification && discussed && understood && <button className="btn" disabled={disabled || incompleteHandoff} onClick={() => void start("to-spec")}>{t("Create specification")}</button>}
      {specReady && !detail.tickets.length && <button className="btn" disabled={disabled || incompleteHandoff} onClick={() => void start("to-tickets")}>{t("Plan tickets")}</button>}
      {detail.tickets.length > 0 && approved("ticket_graph", detail.graph_hash) && <button className="btn" disabled={disabled || incompleteHandoff} onClick={() => void start("implement-spec")}>{t("Start implementation")}</button>}
    </div>}
    {!active && !specification && <p className="field-hint">{t("Plan implementation starts Grill with docs: discuss the idea, approve a specification, then plan Tickets.")}</p>}
    <p className="field-hint">{t("New workspaces use the latest commit. Local changes stay in the original folder.")}</p>
    {detail.tickets.length > 0 && approved("ticket_graph",detail.graph_hash) && !capability?.factory_ready && <div className="assignment-proposal"><p>{t("Native verification will run before implementation.")}</p><ul>{capability?.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul><details><summary>{t("Advanced controls")}</summary><p>{t("Automated implementation needs a verified agent skill setup. Direct work and planning are available before verification.")}</p>
      {!active && <button className="btn" disabled={disabled} onClick={()=>void start("verify-provider")}>{t("Start native verification")}</button>}
      {verification && <button className="btn" disabled={busy} onClick={()=>void perform(async()=>{const result=await factoryRequest<FactoryCapabilities>(`/runs/${verification.id}/verify-provider`,{});if(live.current)onCapabilities(result);})}>{t("Verify native evidence")}</button>}
    </details></div>}
    {specification && <div className="assignment-proposal"><h3>{t("Specification")}</h3><Markdown>{specification.content}</Markdown><div className="factory-actions">
      {!approved("specification", specification.id) && <button className="btn" disabled={busy} onClick={()=>void approve("specification", specification.id, `Specification ${specification.id}, SHA-256 ${specification.hash}`)}>{t("Accept specification")}</button>}
      {!approved("testing_seams", specification.id) && <button className="btn" disabled={busy} onClick={()=>void approve("testing_seams", specification.id, `The testing boundaries and validation plan in specification ${specification.id}, SHA-256 ${specification.hash}`)}>{t("Confirm testing seams")}</button>}
    </div></div>}
    {detail.tickets.length>0 && <div className="assignment-proposal"><h3>{t("Tickets")}</h3>{detail.tickets.map(ticket=><article key={ticket.id}><strong>{ticket.title}</strong><p>{ticket.acceptance}</p></article>)}{!approved("ticket_graph",detail.graph_hash)&&<button className="btn" disabled={busy} onClick={()=>void approve("ticket_graph", detail.graph_hash, `Ticket graph ${detail.graph_hash}; ${detail.tickets.map(t=>t.id).join(", ")}`)}>{t("Approve Ticket graph")}</button>}</div>}
    {questions.length > 0 && <div className="assignment-proposal"><h3>{t("Questions")}</h3>{questions.map(q => <article key={q.id}><p>{q.question}</p>{q.answer === null && q.answer_kind !== "confirmation" ? <form className="factory-form" onSubmit={event => {event.preventDefault();const answer=new FormData(event.currentTarget).get("answer");void perform(async()=>{await factoryRequest(`${prefix}/questions/${q.id}/answer`,{revision:q.revision,answer:String(answer??"")}); if (active) { const updated = await factoryDetail(detail.implementation.id); const context = updated.question_context ?? { questions: updated.questions, revision: updated.question_revision }; if (context.questions.every(question => question.answer !== null)) { const sent = await factoryRequest<{ condition: string }>(`/runs/${active.id}/send-answers`, { revision: context.revision, idempotency_key: crypto.randomUUID() }); if (!["sent", "queued", "sending"].includes(sent.condition)) throw new Error(t("Delivery was not confirmed. Inspect the agent before sending again.")); } }});}}><label>{t("Your answer")}<textarea className="input" name="answer" required /></label><button className="btn" disabled={busy}>{t("Save answer")}</button></form> : q.answer !== null ? <p>{q.answer}</p> : null}</article>)}
      {(!specification || questions.some(q=>q.answer===null && q.answer_kind==="confirmation")) && active?.action !== "verify-provider" && !approved("shared_understanding", detail.question_revision) && <button className="btn" disabled={busy || questions.some(q=>q.answer===null && q.answer_kind!=="confirmation")} onClick={()=>void approve("shared_understanding", detail.question_revision, questions.map(q=>`${q.question}\n${q.answer ?? "Confirmed"}`).join("\n\n"))}>{t("Confirm shared understanding")}</button>}
      {active && <button className="btn" disabled={busy || questions.some(q=>q.answer===null)} onClick={()=>void perform(async()=>{const sent=await factoryRequest<{condition:string}>(`/runs/${active.id}/send-answers`,{revision:questionRevision,idempotency_key:crypto.randomUUID()});if(!["sent", "queued", "sending"].includes(sent.condition))throw new Error(t("Delivery was not confirmed. Inspect the agent before sending again."));})}>{t("Send answered context")}</button>}
    </div>}
  </section>;
}
