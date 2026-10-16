import { FactoryBoardProgress } from "./FactoryBoardProgress.tsx";
import type { FactoryBoardLane } from "../../shared/factory.ts";
import { FactoryCapacityPanel } from "./FactoryCapacityPanel.tsx";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, Archive, MessageSquarePlus, Paperclip, Plus, RefreshCw, Settings } from "lucide-react";
import type { FactoryBoardItem, FactoryCurrent, FactoryReviewDetail, FactoryOverview, FactoryProvider, FactoryStage, Implementation, RunCondition, SpecificationVersion } from "../../shared/protocol.ts";
import type { AgentModelSelection } from "../../shared/agent-models.ts";
import type { Machine } from "../../shared/machines.ts";
import { factoryCurrent, factoryRequest } from "../lib/factoryApi.ts";
import { AssignmentDelete } from "./AssignmentDelete.tsx";
import { ApiError } from "../lib/api.ts";
import { useT } from "../lib/i18n.ts";
import { ProjectUpstreamStatus } from "./ProjectUpstreamStatus.tsx";
import { OpenFileContext } from "../lib/filePaths.ts";
import { base64FromBytes } from "../lib/api.ts";
import { Markdown } from "./Markdown.tsx";
import { FactoryOperationsPanel } from "./FactoryOperationsPanel.tsx";
import { FactoryWorkflowPanel } from "./FactoryWorkflowPanel.tsx";
import { FactoryArtifactPreview } from "./FactoryArtifactPreview.tsx";
import { IssueQueueStatus } from "./IssueQueueStatus.tsx";
import { AssignmentIssueSource } from "./AssignmentIssueSource.tsx";
import { IssueRunContract } from "./IssueRunContract.tsx";
import { FactoryDetailSection } from "./FactoryDetailSection.tsx";
import { FactoryReviewPanel } from "./FactoryReviewPanel.tsx";
import { FactoryAutomaticExecution } from "./FactoryAutomaticExecution.tsx";
import { FactoryExecutionPanel } from "./FactoryExecutionPanel.tsx";
import { FactoryPublicationPanel } from "./FactoryPublicationPanel.tsx";
import { FactoryRetrospectivePanel } from "./FactoryRetrospectivePanel.tsx";
import { AssignmentActions } from "./AssignmentActions.tsx";
import { AssignmentPause } from "./AssignmentPause.tsx";
import { useFactoryCapabilities } from "../lib/useFactoryCapabilities.ts";
import { WorkflowConversations } from "./WorkflowConversations.tsx";
import { RetainedNativeTurn } from "./RetainedNativeTurn.tsx";
import { FactoryBoardStatus } from "./FactoryBoardStatus.tsx";
import { FactoryRunHistory } from "./FactoryRunHistory.tsx";
import { FactoryIssueBatches } from "./FactoryIssueBatches.tsx";
import { factoryReasonRole, factoryConditionLabel } from "../lib/factoryPresentation.ts";
import type { ProjectView } from "../lib/projectNavigation.ts";
import "./FactoryPanel.css";

const lanes: FactoryBoardLane[] = ["inbox", "queued", "running", "needs_you", "done"];
function laneLabel(lane: FactoryBoardLane, t: ReturnType<typeof useT>): string {
  switch (lane) { case "inbox": return t("Inbox"); case "queued": return t("Queued"); case "running": return t("Running"); case "needs_you": return t("Needs you"); case "done": return t("Done"); }
}
function stageLabel(stage: FactoryStage, t: ReturnType<typeof useT>): string {
  switch (stage) { case "inbox": return t("Inbox"); case "specifying": return t("Specifying"); case "ready": return t("Ready"); case "running": return t("Running"); case "review": return t("Review"); case "done": return t("Done"); }
}
function selectedFromUrl(): string | null { const match = /^#factory\/([a-zA-Z0-9-]+)$/.exec(location.hash); return match?.[1] ?? null; }
type PlannedTicket = { key: string; title: string; acceptance: string; dependencies: string[] };

export function FactoryPanel({ overview, refreshOverview, machines, onOpenPane, selectedId, projectId = null, allAssignments = false, onChoose, onNavigate, conversationId, onConversation }: { overview: FactoryOverview | null; refreshOverview: () => Promise<void>; machines: Machine[]; onOpenPane: (machineId: string, paneId: string) => void; selectedId?: string | null; projectId?: string | null; allAssignments?: boolean; onChoose?: (id: string | null) => void; onNavigate?: (view: ProjectView) => void; conversationId?: string; onConversation?: (id: string) => void }) {
  const t = useT();
  const [selected, setSelected] = useState<string | null>(() => selectedId === undefined ? selectedFromUrl() : selectedId);
  const [detail, setDetail] = useState<FactoryCurrent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(busy); busyRef.current = busy;
  const [title, setTitle] = useState(""); const [notes, setNotes] = useState("");
  const [note, setNote] = useState("");
  const [projectFilter, setProjectFilter] = useState(projectId ?? "all");
  const [providerFilter, setProviderFilter] = useState("all");
  const [machineFilter, setMachineFilter] = useState("all");
  const [conditionFilter, setConditionFilter] = useState("all");
  const [selectedChat, setSelectedChat] = useState("");
  const [chatTitle, setChatTitle] = useState("");
  const [specification, setSpecification] = useState("");
  const [testingSeams, setTestingSeams] = useState("Public API and real browser user journeys");
  const [tickets, setTickets] = useState<PlannedTicket[]>([{ key: "t1", title: "", acceptance: "", dependencies: [] }]);
  const [showArchived, setShowArchived] = useState(false);
  const [expandedTickets, setExpandedTickets] = useState<Set<string>>(() => new Set());
  const [source, setSource] = useState<{ id: string; content: string } | null>(null);
  const selection = useRef(selected); selection.current = selected;
  const generation = useRef(0);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const fileInput = useRef<HTMLInputElement>(null);
  function boardLane(item: FactoryOverview["implementations"][number]): FactoryBoardLane {
    return overview?.board?.find(entry => entry.implementation_id === item.id)?.lane ?? ({ inbox: "inbox", specifying: "needs_you", ready: "queued", running: "running", review: "needs_you", done: "done" } as const)[item.stage];
  }
  function boardItem(item: FactoryOverview["implementations"][number]): FactoryBoardItem {
    const projected = overview?.board?.find(entry => entry.implementation_id === item.id);
    if (projected) return projected;
    const legacy = overview?.activity.find(entry => entry.implementation_id === item.id);
    return { implementation_id: item.id, lane: boardLane(item), activity: legacy ? ["work", "implement-spec", "apply-retro"].includes(legacy.action) ? "implementing" : legacy.action === "verify-provider" ? "validating" : "specifying" : null, condition: legacy?.condition ?? null, run_id: legacy?.run_id ?? null, busy: !!legacy && ["working", "accepted", "disconnected"].includes(legacy.condition), waiting_reason: legacy?.waiting_reason ?? null, ticket_progress: legacy && legacy.total_tickets > 0 ? { completed: legacy.completed_tickets, total: legacy.total_tickets } : null };
  }

  async function refresh(): Promise<void> {
    const current = ++generation.current; const id = selection.current;
    const item = id ? await factoryCurrent(id).catch(error => { if (error instanceof ApiError && error.status === 404) return null; throw error; }) : null;
    if (current !== generation.current || id !== selection.current) return;
    setDetail(item);
    if (id && !item) { window.dispatchEvent(new Event("factory-changed")); choose(null); }
  }
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try { if (document.visibilityState === "visible" && !busyRef.current) await refresh(); }
      catch (failure) { if (live) setError(failure instanceof Error ? failure.message : String(failure)); }
      finally { if (live) timer = setTimeout(() => void read(), 5000); }
    };
    void read();
    return () => { live = false; generation.current++; clearTimeout(timer); };
  }, [selected]);
  useEffect(() => { setNote(""); setSpecification(""); setSource(null); setSelectedChat(""); }, [selected]);
  function choose(id: string | null): void {
    generation.current++; selection.current = id; setSelected(id); setDetail(null);
    onChoose?.(id);
    if (!onChoose) history.replaceState(history.state, "", id ? `#factory/${id}` : "#factory");
  }
  async function perform(action: () => Promise<void>): Promise<void> {
    if (busy) return;
    setBusy(true); setError(null);
    try { await action(); await refresh(); }
    catch (failure) { setError(failure instanceof Error ? ("detail" in failure ? String(failure.detail) : failure.message) : String(failure)); await refresh().catch(() => {}); }
    finally { setBusy(false); }
  }
  const prefix = selected ? `/implementations/${selected}` : "";
  const currentSpec: SpecificationVersion | undefined = detail?.specifications.at(-1);
  const automatic = detail?.approvals.some(a => a.kind === "specification" && a.revision === currentSpec?.id && a.automatic_execution);
  const issueSource = detail?.github_sources?.find(source => source.kind === "issue" && source.current);
  const issueScope = issueSource ? { source_id: issueSource.id, source_revision: issueSource.revision } : undefined;
  const selectedProject = overview?.projects.find((project) => project.id === detail?.implementation.project_id);
  const boardProject = overview?.projects.find((project) => project.id === projectId);
  const effectiveProvider = detail?.implementation.provider ?? selectedProject?.provider ?? overview?.settings.provider;
  const effectiveMachine = detail?.implementation.machine_id ?? selectedProject?.machine_id ?? "local";
  const [preset, setPreset] = useState<AgentModelSelection>({ model: null, reasoning: null });
  useEffect(() => {
    setPreset(selectedProject && selectedProject.provider === effectiveProvider ? selectedProject.execution_preset ?? { model: null, reasoning: null } : { model: null, reasoning: null });
  }, [detail?.implementation.id, effectiveProvider, effectiveMachine, selectedProject?.id, selectedProject?.execution_preset?.model, selectedProject?.execution_preset?.reasoning, detail?.runs.at(-1)?.id]);
  const checkout = overview?.checkouts.find((entry) => entry.project_id === selectedProject?.id && entry.machine_id === effectiveMachine);
  const execution = useFactoryCapabilities(effectiveMachine, detail?.implementation.id ?? null, JSON.stringify(selectedProject?.account_bindings?.[effectiveMachine] ?? {}));
  const chatId = selectedChat;
  async function capture(event: FormEvent): Promise<void> {
    event.preventDefault(); await perform(async () => {
      const idea = await factoryRequest<Implementation>("/implementations", { title, description: notes, project_id: projectId });
      if (!mounted.current) return;
      setTitle(""); setNotes(""); choose(idea.id);
    });
  }
  async function attach(file: File): Promise<void> {
    await perform(async () => {
      if (!overview || file.size > overview.settings.max_artifact_bytes) throw new Error(t("This attachment exceeds the size limit."));
      const bytes = new Uint8Array(await file.arrayBuffer());
      const media = file.name.toLowerCase().endsWith(".md") ? "text/markdown" : file.type || "text/plain";
      await factoryRequest(`${prefix}/artifacts`, { chat_id: chatId || (await factoryRequest<import("../../shared/factory.ts").FactoryDetail>(prefix)).chats[0]?.id || "", name: file.name, media_type: media, content_base64: base64FromBytes(bytes), size: file.size, origin: "upload" });
    });
  }

  return <OpenFileContext.Provider value={null}><section className="factory-panel" aria-label={t("Factory")}>
    <div className="factory-heading"><h1>{selected ? selectedProject?.name ?? t("Assignments") : boardProject ? boardProject.name : allAssignments ? t("Assignments") : t("Inbox")}</h1><div className="factory-heading-actions">
      {!selected && allAssignments && boardProject && <>
        <button className="btn factory-heading-button factory-button" aria-label={t("Project settings for {name}", { name: boardProject.name })} onClick={() => onNavigate?.({ kind: "project-settings", id: boardProject.id })}><Settings aria-hidden="true" />{t("Settings")}</button>
        <button className="btn factory-heading-button btn-primary factory-button" onClick={() => onNavigate?.({ kind: "project-inbox", id: boardProject.id })}><MessageSquarePlus aria-hidden="true" />{t("Add message")}</button>
      </>}
      {(selected || !allAssignments || !projectId) && <button className="btn factory-heading-button factory-button" onClick={() => selected ? choose(null) : onNavigate?.(projectId ? { kind: "project", id: projectId } : { kind: allAssignments ? "inbox" : "assignments" })}><ArrowLeft aria-hidden="true" />{selected || !allAssignments ? t("Assignments") : t("Inbox")}</button>}
      <button className="icon-button" aria-label={t("Refresh factory")} disabled={busy} onClick={() => void perform(refreshOverview)}><RefreshCw aria-hidden="true" /></button>
    </div></div>
    {overview && <FactoryCapacityPanel capacity={overview.capacity} />}
    {error && <p role="alert" className="error-state">{error}</p>}
    {busy && <p role="status">{t("Saving…")}</p>}
    {!overview && <p role="status">{t("Loading…")}</p>}
    {!selected && overview && <>
      <FactoryOperationsPanel overview={overview} busy={busy} perform={perform} showCapacity={false} />
      {allAssignments && boardProject && <ProjectUpstreamStatus key={boardProject.id} projectId={boardProject.id} />}
      {!allAssignments && <form className="factory-form factory-capture" onSubmit={(event) => void capture(event)}>
        <label>{t("Idea title")}<input className="input factory-input" value={title} onChange={(event) => setTitle(event.target.value)} required maxLength={200} /></label>
        <label>{t("Idea notes")}<textarea className="input factory-input" value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={100_000} /></label>
        <button className="btn btn-primary factory-button" disabled={busy}>{t("Capture idea")}</button>
      </form>}
      <button className="btn factory-button" aria-pressed={showArchived} onClick={() => setShowArchived(!showArchived)}>{t("Archived tasks")}</button>
      <div className="factory-filters">
        <label>{t("Run condition")}<select className="select factory-input" value={conditionFilter} onChange={(event) => setConditionFilter(event.target.value)}><option value="all">{t("All conditions")}</option>{["needs_you", "blocked", "disconnected", "interrupted", "working", "ready", "completed", "cancelled", "failed"].map((condition) => <option key={condition} value={condition}>{factoryConditionLabel(condition as RunCondition, t)}</option>)}</select></label>
        {!projectId && <label>{t("Project")}<select className="select factory-input" value={projectFilter} disabled={!!projectId} onChange={(event) => setProjectFilter(event.target.value)}><option value="all">{t("All Projects")}</option><option value="unassigned">{t("Unassigned")}</option>{overview.projects.filter((p) => !p.removed_at).map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>}
        <label>{t("Provider")}<select className="select factory-input" value={providerFilter} onChange={(event) => setProviderFilter(event.target.value)}><option value="all">{t("All providers")}</option><option>codex</option><option>claude</option><option>opencode</option></select></label>
        <label>{t("Machine")}<select className="select factory-input" value={machineFilter} onChange={(event) => setMachineFilter(event.target.value)}><option value="all">{t("All Machines")}</option>{machines.map((machine) => <option key={machine.id} value={machine.id}>{machine.name}</option>)}</select></label>
      </div>
      <div className={`factory-board${showArchived || allAssignments ? "" : " factory-inbox-board"}`}>{(showArchived || allAssignments ? lanes : ["inbox"] as FactoryBoardLane[]).map((stage) => <section className="factory-lane" key={stage} aria-label={laneLabel(stage, t)}><h2>{laneLabel(stage, t)}</h2>
        {overview.implementations.filter((item) => boardLane(item) === stage && (showArchived ? !!item.archived_at : !item.archived_at) && (conditionFilter === "all" || overview.activity.some((activity) => activity.implementation_id === item.id && activity.condition === conditionFilter)) && (projectFilter === "all" || (item.project_id ?? "unassigned") === projectFilter) && (providerFilter === "all" || (item.provider ?? overview.projects.find((project) => project.id === item.project_id)?.provider ?? overview.settings.provider) === providerFilter) && (machineFilter === "all" || (item.machine_id ?? overview.projects.find((project) => project.id === item.project_id)?.machine_id ?? "local") === machineFilter)).map((item) => {
          const progress = overview.progress?.find(progress => progress.implementation_id === item.id);
          const state = boardItem(item);
          const executionActivity = ["specifying", "implementing", "validating", "reviewing", "researching", "setting_up", "reflecting"].includes(state.activity ?? "");
          return <article className="factory-card" key={item.id} aria-label={item.title}>
          <button className="factory-card-title" onClick={() => choose(item.id)}>{item.title}</button><p>{overview.projects.find((project) => project.id === item.project_id)?.name ?? t("Unassigned")}</p><small>{item.provider ?? overview.projects.find((project) => project.id === item.project_id)?.provider ?? overview.settings.provider} · {machines.find((machine) => machine.id === (item.machine_id ?? overview.projects.find((project) => project.id === item.project_id)?.machine_id))?.name ?? item.machine_id ?? overview.projects.find((project) => project.id === item.project_id)?.machine_id ?? t("Unassigned")}</small><time>{new Date(item.updated_at).toLocaleString()}</time>
          <FactoryBoardProgress idea={item} progress={progress} waitingReason={state.waiting_reason} expanded={expandedTickets.has(item.id)} onExpandedChange={open => setExpandedTickets(current => { if (current.has(item.id) === open) return current; const next = new Set(current); if (open) next.add(item.id); else next.delete(item.id); return next; })} />
          <FactoryBoardStatus state={state} showActivity={!executionActivity || (!progress?.activities.length && item.pause?.condition !== "paused")} showTicketProgress={!progress?.tickets.length} />
          {item.intake && <IssueQueueStatus entry={item.intake} />}
        </article>})}
      </section>)}</div>
    </>}
    {selected && detail && overview && <div className="factory-detail">
      <section className="factory-section"><div className="project-assignment-heading"><h2>{detail.implementation.title}</h2>{(detail.implementation.stage === "done" || detail.implementation.archived_at) && <button className="btn" disabled={busy} onClick={() => void perform(async () => { await factoryRequest(`${prefix}/${detail.implementation.archived_at ? "restore" : "archive"}`, {}); })}><Archive />{detail.implementation.archived_at ? t("Restore") : t("Archive task")}</button>}</div><p>{detail.board ? laneLabel(detail.board.lane, t) : stageLabel(detail.implementation.stage, t)}</p>{detail.board && <FactoryBoardStatus state={detail.board} />}
        {detail.implementation.description && <Markdown>{detail.implementation.description}</Markdown>}
        <div className="factory-filters">
          <label>{t("Project")}<select className="select factory-input" value={detail.implementation.project_id ?? ""} disabled={busy} onChange={(event) => void perform(async () => { await factoryRequest(`${prefix}/configure`, { project_id: event.target.value || null }); })}><option value="">{t("Unassigned")}</option>{overview.projects.filter((p) => !p.removed_at).map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
        </div><p className="factory-context">{effectiveProvider} · {machines.find((machine) => machine.id === effectiveMachine)?.name ?? effectiveMachine} · {checkout?.path ?? t("No verified checkout")}</p>
      </section>
      <AssignmentIssueSource runs={detail.runs} events={detail.events} busy={busy} perform={perform} sources={detail.github_sources ?? []} problem={detail.github_sync?.problem ?? null} tickets={detail.tickets} graphHash={detail.graph_hash} questionRevision={detail.question_revision} preset={preset} />
      <AssignmentActions preset={preset} onPresetChange={setPreset} key={detail.implementation.id} detail={detail} project={selectedProject} machineId={effectiveMachine} machineName={machines.find(m=>m.id===effectiveMachine)?.name??effectiveMachine} provider={effectiveProvider??"codex"} busy={busy} perform={perform} onOpenPane={onOpenPane} capabilities={execution.capabilities} problem={execution.problem} onCapabilities={execution.apply} />
      <AssignmentPause assignment={detail.implementation} busy={busy} perform={perform} />
      <AssignmentDelete key={detail.implementation.id} assignment={detail.implementation} busy={busy} perform={perform} onDeleted={() => choose(null)} />
      <WorkflowConversations detail={detail} machines={machines} selectedId={conversationId} onSelect={id => onConversation?.(id)} onOpenPane={onOpenPane} busy={busy} perform={perform} />
      <FactoryAutomaticExecution detail={detail} onOpenPane={onOpenPane} />
      <FactoryPublicationPanel key={detail.implementation.id} detail={detail} busy={busy} perform={perform} />
      {detail.implementation.project_id && <FactoryIssueBatches key={detail.implementation.id} implementationId={detail.implementation.id} projectId={detail.implementation.project_id} busy={busy} perform={perform} />}
      <FactoryDetailSection<FactoryReviewDetail> view="review" key={`review-${detail.implementation.id}`} id={detail.implementation.id} revision={detail.revision} title={t("Review changes")}>{full => <FactoryReviewPanel detail={full} busy={busy} perform={perform} />}</FactoryDetailSection>
      {detail.runs.map(run => <IssueRunContract compact key={run.id} run={run} busy={busy} perform={perform} />)}
      <FactoryDetailSection key={`history-${detail.implementation.id}`} id={detail.implementation.id} revision={detail.revision} title={t("Advanced controls")}>{detail => { const chatId = detail.chats.find(chat => chat.id === selectedChat)?.id ?? detail.chats[0]?.id ?? ""; return <>
        {detail.runs.map(run => <IssueRunContract key={run.id} run={run} busy={busy} perform={perform} />)}
        <div className="factory-filters">
          <label>{t("Provider")}<select className="select factory-input" value={detail.implementation.provider ?? ""} disabled={busy} onChange={(event) => void perform(async () => { await factoryRequest(`${prefix}/configure`, { provider: (event.target.value || null) as FactoryProvider | null }); })}><option value="">{t("Project default")}</option><option>codex</option><option>claude</option><option>opencode</option></select></label>
          <label>{t("Machine")}<select className="select factory-input" value={detail.implementation.machine_id ?? ""} disabled={busy} onChange={(event) => void perform(async () => { await factoryRequest(`${prefix}/configure`, { machine_id: event.target.value || null }); })}><option value="" disabled={!selectedProject}>{selectedProject ? t("Project default") : t("Select a Machine")}</option>{machines.map((machine) => <option key={machine.id} value={machine.id}>{machine.name}</option>)}</select></label>
        </div>
      <FactoryWorkflowPanel preset={preset} detail={detail} machineId={effectiveMachine} provider={effectiveProvider ?? "codex"} busy={busy} perform={perform} showQuestions={false} capabilities={execution.capabilities} problem={execution.problem} onCapabilities={execution.apply} />
      <FactoryExecutionPanel detail={detail} project={selectedProject} busy={busy} perform={perform} onOpenPane={onOpenPane} />
      <FactoryRunHistory runs={detail.runs} />
      <section className="factory-section"><h3>{t("Notes")}</h3><label>{t("Chat")}<select className="select factory-input" value={chatId} onChange={(event) => setSelectedChat(event.target.value)}>{detail.chats.map((chat) => <option key={chat.id} value={chat.id}>{chat.title}</option>)}</select></label><form className="factory-form" onSubmit={(event) => { event.preventDefault(); void perform(async () => { const chat = await factoryRequest<{ id: string }>(`${prefix}/chats`, { title: chatTitle }); setSelectedChat(chat.id); setChatTitle(""); }); }}><label>{t("Chat title")}<input className="input factory-input" required maxLength={200} value={chatTitle} onChange={(event) => setChatTitle(event.target.value)} /></label><button className="btn factory-button" disabled={busy}>{t("New chat")}</button></form>{detail.messages.filter((message) => message.chat_id === chatId).map((message) => <article className="factory-message" key={message.id}><small>{message.role} · {new Date(message.created_at).toLocaleString()}</small><Markdown>{message.content}</Markdown></article>)}
        <form className="factory-form" onSubmit={(event) => { event.preventDefault(); void perform(async () => { await factoryRequest(`${prefix}/messages`, { chat_id: chatId, role: "owner", content: note }); setNote(""); }); }}><label>{t("New note")}<textarea className="input factory-input" value={note} onChange={(event) => setNote(event.target.value)} required maxLength={100_000} /></label><button className="btn factory-button" disabled={busy}>{t("Save note")}</button></form>
      </section>
      <section className="factory-section"><h3>{t("Attachments")}</h3><input ref={fileInput} type="file" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void attach(file); event.target.value = ""; }} /><button className="btn factory-button" disabled={busy} onClick={() => fileInput.current?.click()}><Paperclip aria-hidden="true" />{t("Add attachment")}</button>
        {detail.artifacts.map((artifact) => <article key={artifact.id} className="factory-artifact"><h4>{artifact.name} · v{artifact.version}</h4><small>{artifact.size.toLocaleString()} B · {artifact.origin}</small><form className="factory-form" onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget); void perform(async () => { await factoryRequest(`/artifacts/${artifact.id}/note`, { note: String(data.get("note") ?? "") }); }); }}><label>{t("Attachment annotation")}<textarea className="input factory-input" name="note" defaultValue={artifact.note} maxLength={10000} /></label><button className="btn factory-button" disabled={busy}>{t("Save annotation")}</button><button type="button" className="btn factory-button" disabled={busy} onClick={() => void perform(async () => { await factoryRequest(`/artifacts/${artifact.id}/delete`, { hash: artifact.hash }); })}>{t("Delete attachment version")}</button></form>
          <div className="factory-actions"><button className="btn factory-button" onClick={() => void perform(async () => { const response = await fetch(`/api/factory/artifacts/${artifact.id}/download`); if (!response.ok) throw new Error(t("Attachment unavailable")); const url = URL.createObjectURL(await response.blob()); const link = document.createElement("a"); link.href = url; link.download = artifact.name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); })}>{t("Download")}</button><button className="btn factory-button" onClick={() => void perform(async () => { const response = await fetch(`/api/factory/artifacts/${artifact.id}/source`); if (!response.ok) throw new Error(t("Attachment unavailable")); setSource({ id: artifact.id, content: await response.text() }); })}>{t("Source")}</button></div>
          {(artifact.media_type === "text/html" || artifact.media_type.startsWith("image/")) && <FactoryArtifactPreview artifact={artifact} />}
          {(artifact.media_type === "text/markdown" || artifact.media_type === "text/plain") && <button className="btn factory-button" onClick={() => void perform(async () => { const response = await fetch(`/api/factory/artifacts/${artifact.id}/source`); if (!response.ok) throw new Error(t("Attachment unavailable")); setSource({ id: artifact.id, content: await response.text() }); })}>{t("Preview")}</button>}
          {source?.id === artifact.id && (artifact.media_type === "text/markdown" ? <Markdown>{source.content}</Markdown> : <pre>{source.content}</pre>)}
        </article>)}
      </section>
      <section className="factory-section"><h3>{t("Specification")}</h3>{!automatic && <label>{t("Testing seams")}<textarea className="input factory-input" value={testingSeams} onChange={(event) => setTestingSeams(event.target.value)} /></label>}{currentSpec && <><p>{t("Revision {revision}", { revision: currentSpec.revision })}</p><Markdown>{currentSpec.content}</Markdown><div className="factory-actions"><button className="btn factory-button" disabled={busy || detail.approvals.some((approval) => approval.kind === "specification" && approval.revision === currentSpec.id)} onClick={() => void perform(async () => { await factoryRequest(`${prefix}/specification-acceptance`, { specification_id: currentSpec.id, hash: currentSpec.hash, source: "button" }); })}>{t("Accept specification")}</button>{!automatic && <button className="btn factory-button" disabled={busy} onClick={() => void perform(async () => { await factoryRequest(`${prefix}/approvals`, { kind: "testing_seams", revision: currentSpec.id, scope: testingSeams, issue_scope: issueScope }); })}>{t("Confirm testing seams")}</button>}</div></>}
        <form className="factory-form" onSubmit={(event) => { event.preventDefault(); void perform(async () => { await factoryRequest(`${prefix}/specifications`, { content: specification }); setSpecification(""); }); }}><label>{t("Specification text")}<textarea className="input factory-input" value={specification} onChange={(event) => setSpecification(event.target.value)} required maxLength={250_000} /></label><button className="btn factory-button" disabled={busy}>{t("Save new revision")}</button></form>
      </section>
      <section className="factory-section"><h3>{t("Tickets")}</h3>{detail.tickets.map((ticket) => <article className="factory-message" key={ticket.id}><strong>{ticket.title}</strong><p>{ticket.acceptance}</p><small>{ticket.status} · {ticket.dependencies.length} {t("Dependencies")}</small></article>)}
        {detail.tickets.length > 0 && !automatic && <button className="btn factory-button" disabled={busy} onClick={() => void perform(async () => { await factoryRequest(`${prefix}/approvals`, { kind: "ticket_graph", revision: detail.graph_hash, scope: `Ticket graph ${detail.graph_hash}; ${detail.tickets.map((ticket) => ticket.id).join(", ")}`, issue_scope: issueScope }); })}>{t("Approve Ticket graph")}</button>}
        {currentSpec && !automatic && <form className="factory-form" onSubmit={(event) => { event.preventDefault(); void perform(async () => { await factoryRequest(`${prefix}/tickets`, { specification_id: currentSpec.id, tickets }); }); }}>{tickets.map((ticket, index) => <fieldset key={ticket.key}><legend>{ticket.key}</legend><label>{t("Ticket title")}<input className="input factory-input" value={ticket.title} required onChange={(event) => setTickets((rows) => rows.map((row, position) => position === index ? { ...row, title: event.target.value } : row))} /></label><label>{t("Acceptance criteria")}<textarea className="input factory-input" value={ticket.acceptance} required onChange={(event) => setTickets((rows) => rows.map((row, position) => position === index ? { ...row, acceptance: event.target.value } : row))} /></label><label>{t("Dependencies")}<select className="select factory-input" multiple value={ticket.dependencies} onChange={(event) => { const dependencies = Array.from(event.target.selectedOptions, (option) => option.value); setTickets((rows) => rows.map((row, position) => position === index ? { ...row, dependencies } : row)); }}>{tickets.filter((row) => row.key !== ticket.key).map((row) => <option key={row.key} value={row.key}>{row.key} · {row.title}</option>)}</select></label></fieldset>)}<div className="factory-actions"><button type="button" className="btn factory-button" onClick={() => setTickets((rows) => [...rows, { key: `t${rows.length + 1}`, title: "", acceptance: "", dependencies: [] }])}><Plus aria-hidden="true" />{t("Add Ticket")}</button><button className="btn factory-button" disabled={busy}>{t("Propose Tickets")}</button></div></form>}
      </section>
      <section className="factory-section"><h3>{t("Run history")}</h3>{detail.runs.map((run) => <article className="factory-message" key={run.id}><strong>{run.action}</strong><p>{run.provider} · {run.machine_id} · {run.condition}</p>{run.waiting_reason && <p role={factoryReasonRole(run.condition)}>{run.waiting_reason}</p>}<div className="factory-actions">{run.pane_id && <button className="btn factory-button" onClick={() => onOpenPane(run.machine_id, run.pane_id!)}>{t("Open agent")}</button>}<button className="btn factory-button" disabled={busy} onClick={() => void perform(async () => { await factoryRequest(`/runs/${run.id}/reconcile`, {}); })}>{t("Reconcile Run")}</button><button className="btn factory-button" disabled={busy} onClick={() => void perform(async () => { await factoryRequest(`/runs/${run.id}/import-conversation`, {}); })}>{t("Retain native conversation")}</button><button className="btn factory-button" disabled={busy} onClick={() => void perform(async () => { await factoryRequest(`/runs/${run.id}/import-artifacts`, {}); })}>{t("Import research outputs")}</button><button className="btn factory-button" disabled={busy || ["cancelled", "completed"].includes(run.condition) && !run.implementation_completion_pending} onClick={() => void perform(async () => { await factoryRequest(`/runs/${run.id}/stop`, { summary: "Owner stopped this attempt" }); })}>{t("Stop Run")}</button><button className="btn factory-button" disabled={busy || !["completed", "cancelled", "failed"].includes(run.condition)} onClick={() => void perform(async () => { await factoryRequest(`/runs/${run.id}/cleanup`, {}); })}>{t("Remove clean checkout")}</button></div></article>)}</section>
      <FactoryRetrospectivePanel preset={preset} detail={detail} busy={busy} perform={perform} />
      <section className="factory-section"><h3>{t("Retained native conversations")}</h3>{detail.native_snapshots.map((snapshot) => <details key={snapshot.id}><summary>{snapshot.run_id} · {snapshot.sequence} · {new Date(snapshot.created_at).toLocaleString()}</summary>{snapshot.turns.map((turn, index) => <RetainedNativeTurn key={index} turn={turn} />)}{snapshot.cursor && <button className="btn factory-button" disabled={busy} onClick={() => void perform(async () => { await factoryRequest(`/runs/${snapshot.run_id}/import-conversation`, { before: snapshot.cursor ?? undefined }); })}>{t("Retain older native history")}</button>}</details>)}</section>
      <section className="factory-section"><h3>{t("History")}</h3>{detail.events.map((event) => <p key={event.id}><time>{new Date(event.created_at).toLocaleString()}</time> · {event.kind}</p>)}</section>
      </>; }}</FactoryDetailSection>
    </div>}
  </section></OpenFileContext.Provider>;
}
