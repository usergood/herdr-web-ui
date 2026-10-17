import { issueImplementationStart } from "../lib/issueStart.ts";
import { latestImplementationAttempt } from "../../shared/issue-queue.ts";
import { useEffect, useRef, useState } from "react";
import { MessageSquare, Play, ListChecks } from "lucide-react";
import type { FactoryAction, FactoryCapabilities, FactoryCurrent, FactoryCapacityWait, FactoryProject, FactoryProvider, FactoryRun } from "../../shared/protocol.ts";
import { factoryCurrent, factoryRequest } from "../lib/factoryApi.ts";
import { useT } from "../lib/i18n.ts";
import { Markdown } from "./Markdown.tsx";
import "./AssignmentActions.css";
import { AgentModelPicker } from "./AgentModelPicker.tsx";
import type { AgentExecutionPreset, AgentModelSelection } from "../../shared/agent-models.ts";
import { AssignmentDeliveryPanel } from "./AssignmentDeliveryPanel.tsx";
import { FactoryReport } from "./FactoryReport.tsx";
import { FactoryUpstreamRelease } from "./FactoryUpstreamRelease.tsx";

export function AssignmentActions({ preset, onPresetChange, detail, project, machineId, machineName, provider, busy, perform, onOpenPane, capabilities, problem, onCapabilities }: { preset: AgentModelSelection; onPresetChange: (value: AgentModelSelection) => void; detail: FactoryCurrent; project?: FactoryProject; machineId: string; machineName: string; provider: FactoryProvider; busy: boolean; perform: (action: () => Promise<void>) => Promise<void>; onOpenPane: (machineId: string, paneId: string) => void; capabilities: FactoryCapabilities | null; problem: string | null; onCapabilities: (value: FactoryCapabilities) => void }) {
  const t = useT(); const live = useRef(true);
  const prefix = `/implementations/${detail.implementation.id}`;
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const capability = capabilities?.providers.find(entry => entry.provider === provider);
  const active = [...detail.runs].reverse().find(run => ["accepted", "working", "ready", "needs_you", "blocked", "disconnected", "interrupted"].includes(run.condition));
  const queued = detail.capacity_waiting?.some(wait => wait.condition === "queued");
  const completionEvidence = detail.implementation.completion_evidence;
  const canAcceptResearch = completionEvidence?.repository_changes === "none" && completionEvidence.quiescent;
  const unconfirmedWork = active?.action === "work" && ["interrupted", "disconnected"].includes(active.condition);
  const specification = detail.specifications.at(-1);
  const issueStart = issueImplementationStart(detail);
  const retainedIssuePlan = detail.github_sources?.find(source => source.kind === "issue" && source.planning && source.planning.specification_id === specification?.id && source.planning.graph_hash === detail.graph_hash)?.planning;
  const issuePlan = retainedIssuePlan?.condition === "prepared" ? retainedIssuePlan : undefined;
  const approved = (kind: string, revision: string) => detail.approvals.some(a => a.kind === kind && a.revision === revision);
  const automatic = detail.approvals.some(a => a.kind === "specification" && a.automatic_execution && a.revision === specification?.id) || !!(active?.manifest as { planning_authority?: unknown } | undefined)?.planning_authority;
  const executionPlan = detail.execution_plans?.find(plan => plan.run_id === active?.id) ?? detail.execution_plans?.at(-1);
  const specReady = !!specification && approved("specification", specification.id) && approved("testing_seams", specification.id);
  const questions = detail.question_context?.questions ?? detail.questions;
  const questionRevision = detail.question_context?.revision ?? detail.question_revision;
  const understood = !questions.length || questions.every(q => q.answer !== null) && approved("shared_understanding", detail.question_revision);
  const discussed = detail.runs.some(run => run.action === "grill-with-docs" || run.action === "grill-me");
  const verification = [...detail.runs].reverse().find(run => run.action === "verify-provider");
  const latest = detail.runs.at(-1);
  const reviewed = latest?.implementation_completion;
  const implementationAttempt = latestImplementationAttempt(detail.runs);
  const retiredStopped = !!implementationAttempt && detail.events.some(event => event.kind === "run_stopped" && (event.data as { run_id?: string; rework_requested?: boolean } | null)?.run_id === implementationAttempt.id && (event.data as { rework_requested?: boolean }).rework_requested);
  const manualReworkRetry = !!implementationAttempt && !issueStart.scope && (implementationAttempt.condition === "cancelled" && retiredStopped || implementationAttempt.condition === "failed" && !!(implementationAttempt.manifest as { rework?: unknown }).rework);
  const acceptedReview = !!reviewed && (latest?.accepted_result?.head === reviewed.head || detail.approvals.some(approval => approval.kind === "review" && approval.revision === reviewed.head && approval.scope.startsWith(`Run ${latest!.id};`)));
  const waitingEvent = detail.events.filter(event => event.kind === "continuation_waiting" && (event.data as { run_id?: string } | null)?.run_id === (active?.id ?? latest?.id)).at(-1);
  const continuationProblem = (waitingEvent?.data as { message?: string } | undefined)?.message;
  const lastHandoffEvent = (kinds: string[]) => latest && detail.events.filter(event => kinds.includes(event.kind) && (event.data as { run_id?: string }).run_id === latest.id).at(-1)?.kind;
  const handoffProblem = lastHandoffEvent(["native_snapshot_unavailable", "planning_handoff_retained"]) === "native_snapshot_unavailable" || lastHandoffEvent(["planning_documents_unavailable", "planning_documents_retained"]) === "planning_documents_unavailable";
  const [acknowledgedHandoff, setAcknowledgedHandoff] = useState<string | null>(null);
  const incompleteHandoff = handoffProblem && acknowledgedHandoff !== latest?.id;
  const check = active ? detail.checks.filter(c=>c.run_id===active.id&&c.worker_id===null).at(-1) : undefined;
  // Retained planning keeps the action visible; issueStart still requires fresh admission.
  const graphReady = detail.tickets.length > 0 && (approved("ticket_graph", detail.graph_hash) || !!retainedIssuePlan && !!issueStart.scope);
  const suggestedAction: FactoryAction | null = graphReady ? "implement-spec" : specReady ? "to-tickets" : !specification && discussed && understood ? "to-spec" : null;
  const nextAction = suggestedAction === active?.action ? null : suggestedAction;
  async function launch(action: FactoryAction) {
      if (!capability?.skills_verified) await factoryRequest(`/machines/${encodeURIComponent(machineId)}/prepare`, {});
      const issueScope = action === "implement-spec" ? issueStart.scope : undefined;
      const direct = action === "work" || !!issueScope && !active;
      const run = await factoryRequest<FactoryRun | FactoryCapacityWait>(prefix + (direct ? "/runs" : "/continue"), { ...(direct ? {} : { run_id: active?.id ?? null, allow_partial_handoff: acknowledgedHandoff === active?.id }), ...(issueScope ? { issue_scope: issueScope } : {}), action, execution_preset: preset, idempotency_key: crypto.randomUUID(), expected: { provider, machine_id: machineId, project_id: detail.implementation.project_id, specification_id: specification?.id ?? null, graph_hash: detail.graph_hash } });
      if (!live.current) return;
      if (run.condition === "queued" || !("pane_id" in run)) return;
      if (!["working", "ready", "needs_you"].includes(run.condition) || !run.pane_id) throw new Error(run.waiting_reason ?? t("The agent did not start. Open advanced controls to inspect the retained attempt."));
      onOpenPane(run.machine_id, run.pane_id);
  }
  async function start(action: FactoryAction) { await perform(() => launch(action)); }
  async function approve(kind: "shared_understanding" | "specification" | "testing_seams" | "ticket_graph", revision: string, scope: string) {
    await perform(async () => {
      const source = kind !== "shared_understanding" ? detail.github_sources?.find(source => source.kind === "issue" && source.current) : undefined;
      await factoryRequest(prefix + "/approvals", { kind, revision, scope, ...(source ? { issue_scope: { source_id: source.id, source_revision: source.revision } } : {}) });
      const updated = await factoryCurrent(detail.implementation.id);
      const spec = updated.specifications.at(-1);
      const accepted = (approvalKind: string, version: string) => updated.approvals.some(a => a.kind === approvalKind && a.revision === version);
      if (kind === "shared_understanding" && !spec) await launch("to-spec");
      else if (kind === "ticket_graph") await launch("implement-spec");
      else if (spec && !updated.tickets.length && accepted("specification", spec.id) && accepted("testing_seams", spec.id)) await launch("to-tickets");
    });
  }
  const disabled = busy || !!detail.implementation.pause || queued || !project || !!project.removed_at || !!detail.implementation.archived_at || !capability?.installed;
  if (detail.implementation.outcome === "discarded") return <section className="assignment-actions factory-section" aria-label={t("Next step")}><p role="status">{t("Discarded")}</p></section>;
  if (detail.implementation.discard_requested_at) return <section className="assignment-actions factory-section" aria-label={t("Next step")}><p className="field-hint">{t("Discard stops owned work and retains chats, artifacts and branches.")}</p><button className="btn factory-button" disabled={busy} onClick={() => void perform(async () => { await factoryRequest(prefix + "/discard", {}); })}>{t("Reconcile Discard")}</button></section>;
  return <section className="assignment-actions factory-section" aria-label={t("Next step")}>
    {detail.implementation.activity === "awaiting_merge" && <div role="status">
      <p>{t("Awaiting merge")}</p>
      <p>{t("Delivery requires verified merge coverage and any required containing release.")}</p>
      {reviewed && <p>{acceptedReview ? t("Reviewed head accepted. Delivery is still pending.") : t("Owner acceptance is still required.")}</p>}
    </div>}
    {!active && latest?.condition === "completed" && !latest.issue_pause && reviewed && !acceptedReview && <button className="btn" disabled={busy} onClick={() => void perform(async () => { await factoryRequest(`/runs/${latest.id}/accept`, { head: reviewed.head }); })}>{t("Accept reviewed head")}</button>}
    <p role="status">{project ? t("Work uses {agent} on {machine} with this Project's settings.", { agent: provider, machine: machineName }) : t("Choose a Project to start work or plan implementation.")}</p>
    {queued && <p role="status">{t("Queued work starts automatically when capacity is available.")}</p>}
    {detail.capacity_waiting?.filter(wait => wait.condition === "blocked").map(wait => <p role="alert" key={wait.id}>{wait.reason}</p>)}
    {automatic && <p role="status">{t("Internal planning continues automatically after Specification approval.")}</p>}
    {detail.automatic_planning?.filter(request => request.condition === "blocked").map(request => <p role="alert" key={request.id}>{request.reason}</p>)}
    {executionPlan && <section className="assignment-proposal" aria-label={t("Execution plan")}><h3>{t("Execution plan")}</h3><h4>{t("Testing plan")}</h4><Markdown>{executionPlan.testing_plan}</Markdown><p>{executionPlan.authority.specification_id} · {executionPlan.hash}</p>{executionPlan.tickets.map(ticket => <article key={ticket.id}><strong>{ticket.title}</strong><p>{ticket.acceptance}</p><small>{t("Dependencies")}: {ticket.dependencies.map(id => executionPlan.tickets.find(t => t.id === id)?.title ?? id).join(", ") || "—"}</small></article>)}</section>}
    {problem && <p role="alert">{problem}</p>}
    {continuationProblem && <p role="alert">{continuationProblem}</p>}
    {!active && project && <AgentModelPicker projectId={project.id} machineId={machineId} provider={provider} accountScope={JSON.stringify(project.account_bindings?.[machineId] ?? {})} value={preset} onChange={onPresetChange} disabled={busy} />}
    {active && <p>{t("Launch model")} · {(active.manifest as { execution_preset?: AgentExecutionPreset }).execution_preset?.model ?? t("Use CLI default")} · {t("Launch reasoning")} · {(active.manifest as { execution_preset?: AgentExecutionPreset }).execution_preset?.reasoning ?? t("Use model default")}</p>}
    {handoffProblem && <div><p role="alert">{t("Some planning context could not be retained. Check the previous agent chat and documents before starting the next step.")}</p>{incompleteHandoff && <button className="btn factory-button" disabled={busy} onClick={() => setAcknowledgedHandoff(latest?.id ?? null)}>{t("Continue with available context")}</button>}</div>}
    {project && !capability?.installed && capabilities && <p role="status">{t("Install or sign in to this Project's agent on its Machine, then try again.")}</p>}
    {detail.implementation.delivery_scope && <p>{t("Delivery milestone")}: {detail.implementation.delivery_scope.milestone === "release" ? t("Containing release") : t("Verified merge")} · {detail.implementation.delivery_scope.branch}</p>}
    {detail.implementation.delivery_scope && detail.runs.length > 0 && <AssignmentDeliveryPanel key={detail.implementation.id} detail={detail} project={project} busy={busy} perform={perform} />}
    {detail.runs.length > 0 && detail.implementation.stage !== "done" && <div className="factory-actions">
      <button className="btn factory-button" disabled={busy} onClick={() => void perform(async () => { await factoryRequest(prefix + "/completion-evidence"); })}>{t("Check completion evidence")}</button>
      {!active && latest?.action === "work" && <button className="btn factory-button" disabled={busy || !!detail.implementation.delivery_scope && !canAcceptResearch} onClick={() => void perform(async () => { await factoryRequest(prefix + "/complete-work", { run_id: latest.id }); })}>{detail.implementation.delivery_scope ? t("Accept research") : t("Mark work done")}</button>}
      <p role={completionEvidence?.reason_is_error || completionEvidence?.repository_changes === "unknown" ? "alert" : "status"}>{completionEvidence?.reason ?? (canAcceptResearch ? t("No repository changes; owned work is quiescent.") : t("Check repository changes and owned work before accepting research."))}</p>
    </div>}
    {active ? <div className="factory-actions">
      {unconfirmedWork && active.waiting_reason && <p role="alert">{active.waiting_reason}</p>}
      <button className="btn btn-primary factory-button" disabled={busy || !active.pane_id} onClick={() => active.pane_id && onOpenPane(active.machine_id, active.pane_id)}><MessageSquare />{t("Continue in agent chat")}</button>
      {!automatic && active.action !== "implement-spec" && nextAction && <button className="btn btn-primary factory-button" disabled={busy || incompleteHandoff || nextAction === "implement-spec" && issueStart.blocked || ["disconnected", "interrupted"].includes(active.condition)} onClick={() => void start(nextAction)}>{t("Continue workflow")}</button>}
      {active.action==="implement-spec" ? !automatic && <button className="btn factory-button" disabled={busy||!!active.issue_pause||!!active.scope_pause||check?.condition!=="passed"} onClick={()=>void perform(async()=>{await factoryRequest(`/runs/${active.id}/accept`,{head:check?.head??""});})}>{t("Accept reviewed head")}</button> : active.action === "work" && active.conversation_kind !== "human_review" ? <button className="btn factory-button" disabled={busy || !unconfirmedWork && !!detail.implementation.delivery_scope && !canAcceptResearch} onClick={() => void perform(async () => { if(!unconfirmedWork)await factoryRequest(prefix+"/complete-work",{run_id:active.id});else await factoryRequest(`/runs/${active.id}/stop`, { summary: "Owner stopped an unconfirmed work attempt; retained work remains available" }); })}>{unconfirmedWork?t("Stop this attempt"):detail.implementation.delivery_scope?t("Accept research"):t("Mark work done")}</button> : null}
      {active.action==="implement-spec" && detail.review_evidence.filter(r=>r.run_id===active.id).map(r=><details key={r.id}><summary>{r.axis} · {r.outcome}</summary><FactoryReport assignmentId={detail.implementation.id} reportId={r.id} /></details>)}
      <p className="field-hint">{unconfirmedWork?t("Stopping keeps the worktree. You can start a new attempt afterwards."):t("Review and continue from this chat. Finished steps keep their history.")}</p>
    </div> : <div className="factory-actions">
      {implementationAttempt && manualReworkRetry && <button className="btn factory-button" disabled={disabled} onClick={() => void perform(async () => { await factoryRequest(`/runs/${implementationAttempt.id}/retry`, { idempotency_key: crypto.randomUUID(), execution_preset: preset }); })}>{t("Retry")}</button>}
      <button className="btn btn-primary factory-button" disabled={disabled} onClick={() => void start("work")}><Play />{t("Start work")}</button>
      {!specification && <button className="btn factory-button" disabled={disabled} onClick={() => void start("grill-with-docs")}><ListChecks />{t("Plan implementation")}</button>}
      {!specification && discussed && understood && <button className="btn factory-button" disabled={disabled || incompleteHandoff} onClick={() => void start("to-spec")}>{t("Create specification")}</button>}
      {!automatic && specReady && !detail.tickets.length && <button className="btn factory-button" disabled={disabled || incompleteHandoff} onClick={() => void start("to-tickets")}>{t("Plan tickets")}</button>}
      {!automatic && graphReady && <button className="btn factory-button" disabled={disabled || incompleteHandoff || issueStart.blocked} onClick={() => void start("implement-spec")}>{t("Start implementation")}</button>}
    </div>}
    {!active && !specification && <p className="field-hint">{t("Plan implementation starts Grill with docs: discuss the idea, approve a specification, then plan Tickets.")}</p>}
    <p className="field-hint">{t("New workspaces use the latest commit. Local changes stay in the original folder.")}</p>
    {graphReady && !capability?.factory_ready && <div className="assignment-proposal"><p>{t("Native verification will run before implementation.")}</p><ul>{capability?.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul><details><summary>{t("Advanced controls")}</summary><p>{t("Automated implementation needs a verified agent skill setup. Direct work and planning are available before verification.")}</p>
      {!active && <button className="btn factory-button" disabled={disabled} onClick={()=>void start("verify-provider")}>{t("Start native verification")}</button>}
      {verification && <button className="btn factory-button" disabled={busy} onClick={()=>void perform(async()=>{const result=await factoryRequest<FactoryCapabilities>(`/runs/${verification.id}/verify-provider`,{});if(live.current)onCapabilities(result);})}>{t("Verify native evidence")}</button>}
    </details></div>}
    {specification && !issuePlan && <div className="assignment-proposal"><h3>{t("Specification")}</h3><FactoryUpstreamRelease release={specification.upstream_update} /><Markdown>{specification.content}</Markdown><div className="factory-actions">
      {!approved("specification", specification.id) && <button className="btn" disabled={busy} onClick={()=>void perform(async () => { await factoryRequest(`${prefix}/specification-acceptance`, { specification_id: specification.id, hash: specification.hash, source: "button" }); })}>{t("Accept specification")}</button>}
      {!automatic && !approved("testing_seams", specification.id) && <button className="btn" disabled={busy} onClick={()=>void approve("testing_seams", specification.id, `The testing boundaries and validation plan in specification ${specification.id}, SHA-256 ${specification.hash}`)}>{t("Confirm testing seams")}</button>}
    </div></div>}
    {!executionPlan && !issuePlan && detail.tickets.length>0 && <div className="assignment-proposal"><h3>{t("Tickets")}</h3>{detail.tickets.map(ticket=><article key={ticket.id}><strong>{ticket.title}</strong><p>{ticket.acceptance}</p></article>)}{!automatic && !approved("ticket_graph",detail.graph_hash)&&<button className="btn" disabled={busy} onClick={()=>void approve("ticket_graph", detail.graph_hash, `Ticket graph ${detail.graph_hash}; ${detail.tickets.map(t=>t.id).join(", ")}`)}>{t("Approve Ticket graph")}</button>}</div>}
    {questions.length > 0 && <div className="assignment-proposal"><h3>{t("Questions")}</h3>{questions.map(q => <article key={q.id}><p>{q.question}</p>{q.answer === null && q.answer_kind !== "confirmation" ? <form className="factory-form" onSubmit={event => {event.preventDefault();const answer=new FormData(event.currentTarget).get("answer");void perform(async()=>{await factoryRequest(`${prefix}/questions/${q.id}/answer`,{revision:q.revision,answer:String(answer??"")}); if (active && !active.issue_pause && !active.scope_pause) { const updated = await factoryCurrent(detail.implementation.id); const context = updated.question_context ?? { questions: updated.questions, revision: updated.question_revision }; if (context.questions.every(question => question.answer !== null)) { const sent = await factoryRequest<{ condition: string }>(`/runs/${active.id}/send-answers`, { revision: context.revision, idempotency_key: crypto.randomUUID() }); if (!["sent", "queued", "sending"].includes(sent.condition)) throw new Error(t("Delivery was not confirmed. Inspect the agent before sending again.")); } }});}}><label>{t("Your answer")}<textarea className="input" name="answer" required /></label><button className="btn" disabled={busy}>{t("Save answer")}</button></form> : q.answer !== null ? <p>{q.answer}</p> : null}</article>)}
      {(!specification || questions.some(q=>q.answer===null && q.answer_kind==="confirmation")) && active?.action !== "verify-provider" && !approved("shared_understanding", detail.question_revision) && <button className="btn" disabled={busy || questions.some(q=>q.answer===null && q.answer_kind!=="confirmation")} onClick={()=>void approve("shared_understanding", detail.question_revision, questions.map(q=>`${q.question}\n${q.answer ?? "Confirmed"}`).join("\n\n"))}>{t("Confirm shared understanding")}</button>}
      {active && !active.issue_pause && !active.scope_pause && <button className="btn" disabled={busy || questions.some(q=>q.answer===null)} onClick={()=>void perform(async()=>{const sent=await factoryRequest<{condition:string}>(`/runs/${active.id}/send-answers`,{revision:questionRevision,idempotency_key:crypto.randomUUID()});if(!["sent", "queued", "sending"].includes(sent.condition))throw new Error(t("Delivery was not confirmed. Inspect the agent before sending again."));})}>{t("Send answered context")}</button>}
    </div>}
  </section>;
}
