import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowDown, ArrowUp, ArrowLeft, Paperclip, Plus, RefreshCw } from "lucide-react";
import type { FactoryDetail, FactoryOverview, FactoryProvider, FactoryStage, Implementation, SpecificationVersion } from "../../shared/protocol.ts";
import type { Machine } from "../../shared/machines.ts";
import { factoryDetail, factoryOverview, factoryRequest } from "../lib/factoryApi.ts";
import { useT } from "../lib/i18n.ts";
import { OpenFileContext } from "../lib/filePaths.ts";
import { Markdown } from "./Markdown.tsx";
import { FactoryWorkflowPanel } from "./FactoryWorkflowPanel.tsx";
import { FactoryArtifactPreview } from "./FactoryArtifactPreview.tsx";
import { FactoryReviewPanel } from "./FactoryReviewPanel.tsx";
import { FactoryExecutionPanel } from "./FactoryExecutionPanel.tsx";
import { FactoryProjectSettings } from "./FactoryProjectSettings.tsx";
import { FactoryRetrospectivePanel } from "./FactoryRetrospectivePanel.tsx";
import { FactoryOperationsPanel } from "./FactoryOperationsPanel.tsx";
import "./FactoryPanel.css";

const stages: FactoryStage[] = ["inbox", "specifying", "ready", "running", "review", "done"];
function stageLabel(stage: FactoryStage, t: ReturnType<typeof useT>): string {
  switch (stage) { case "inbox": return t("Inbox"); case "specifying": return t("Specifying"); case "ready": return t("Ready"); case "running": return t("Running"); case "review": return t("Review"); case "done": return t("Done"); }
}
function selectedFromUrl(): string | null { const match = /^#factory\/([a-zA-Z0-9-]+)$/.exec(location.hash); return match?.[1] ?? null; }
type PlannedTicket = { key: string; title: string; acceptance: string; dependencies: string[] };

export function FactoryPanel({ machines, onOpenPane }: { machines: Machine[]; onOpenPane: (machineId: string, paneId: string) => void }) {
  const t = useT();
  const [overview, setOverview] = useState<FactoryOverview | null>(null);
  const [selected, setSelected] = useState<string | null>(selectedFromUrl);
  const [detail, setDetail] = useState<FactoryDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState(""); const [notes, setNotes] = useState("");
  const [note, setNote] = useState("");
  const [projectFilter, setProjectFilter] = useState("all");
  const [providerFilter, setProviderFilter] = useState("all");
  const [machineFilter, setMachineFilter] = useState("all");
  const [conditionFilter, setConditionFilter] = useState("all");
  const [selectedChat, setSelectedChat] = useState("");
  const [chatTitle, setChatTitle] = useState("");
  const [projectName, setProjectName] = useState(""); const [projectPath, setProjectPath] = useState("");
  const [projectProvider, setProjectProvider] = useState<FactoryProvider>("codex");
  const [projectMachine, setProjectMachine] = useState("local");
  const [specification, setSpecification] = useState("");
  const [testingSeams, setTestingSeams] = useState("Public API and real browser user journeys");
  const [tickets, setTickets] = useState<PlannedTicket[]>([{ key: "t1", title: "", acceptance: "", dependencies: [] }]);
  const [showProjects, setShowProjects] = useState(false);
  const [source, setSource] = useState<{ id: string; content: string } | null>(null);
  const selection = useRef(selected); selection.current = selected;
  const generation = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);

  async function refresh(): Promise<void> {
    const current = ++generation.current; const id = selection.current;
    const [board, item] = await Promise.all([factoryOverview(), id ? factoryDetail(id) : Promise.resolve(null)]);
    if (current !== generation.current || id !== selection.current) return;
    setOverview(board); setDetail(item);
  }
  useEffect(() => {
    let live = true;
    const read = () => refresh().catch((failure: unknown) => { if (live) setError(failure instanceof Error ? failure.message : String(failure)); });
    void read();
    const interval = setInterval(() => { if (document.visibilityState === "visible" && !busy) void read(); }, 5000);
    return () => { live = false; generation.current++; clearInterval(interval); };
  }, [selected, busy]);
  useEffect(() => { setNote(""); setSpecification(""); setSource(null); setSelectedChat(""); }, [selected]);
  function choose(id: string | null): void {
    generation.current++; selection.current = id; setSelected(id); setDetail(null);
    history.replaceState(history.state, "", id ? `#factory/${id}` : "#factory");
  }
  async function perform(action: () => Promise<void>): Promise<void> {
    if (busy) return;
    setBusy(true); setError(null);
    try { await action(); await refresh(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); await refresh().catch(() => {}); }
    finally { setBusy(false); }
  }
  const prefix = selected ? `/implementations/${selected}` : "";
  const currentSpec: SpecificationVersion | undefined = detail?.specifications.at(-1);
  const selectedProject = overview?.projects.find((project) => project.id === detail?.implementation.project_id);
  const effectiveProvider = detail?.implementation.provider ?? selectedProject?.provider ?? overview?.settings.provider;
  const effectiveMachine = detail?.implementation.machine_id ?? selectedProject?.machine_id ?? "local";
  const checkout = overview?.checkouts.find((entry) => entry.project_id === selectedProject?.id && entry.machine_id === effectiveMachine);
  const chatId = detail?.chats.find((chat) => chat.id === selectedChat)?.id ?? detail?.chats[0]?.id;
  async function capture(event: FormEvent): Promise<void> {
    event.preventDefault(); await perform(async () => {
      const idea = await factoryRequest<Implementation>("/implementations", { title, description: notes });
      setTitle(""); setNotes(""); choose(idea.id);
    });
  }
  async function attach(file: File): Promise<void> {
    await perform(async () => {
      if (!overview || file.size > overview.settings.max_artifact_bytes) throw new Error(t("This attachment exceeds the size limit."));
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      for (let start = 0; start < bytes.length; start += 8192) binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
      const media = file.name.toLowerCase().endsWith(".md") ? "text/markdown" : file.type || "text/plain";
      await factoryRequest(`${prefix}/artifacts`, { chat_id: chatId, name: file.name, media_type: media, content_base64: btoa(binary), size: file.size, origin: "upload" });
    });
  }

  return <OpenFileContext.Provider value={null}><section className="factory-panel" aria-label={t("Factory")}>
    <div className="factory-heading"><h1>Saurons eye</h1><button className="btn" onClick={() => choose(null)}><ArrowLeft aria-hidden="true" />{t("Inbox")}</button><button className="btn" onClick={() => setShowProjects((shown) => !shown)} aria-expanded={showProjects}>{t("Projects")}</button><button className="icon-button" aria-label={t("Refresh factory")} disabled={busy} onClick={() => void perform(refresh)}><RefreshCw /></button></div>
    {error && <p role="alert" className="error-state">{error}</p>}
    {busy && <p role="status">{t("Saving…")}</p>}
    {!overview && <p role="status">{t("Loading…")}</p>}
    {overview && <FactoryOperationsPanel overview={overview} busy={busy} perform={perform} />}
    {showProjects && <section className="factory-section"><h2>{t("Projects")}</h2>
      {overview?.projects.map((project) => <p key={project.id}>{project.name} · {project.provider} · {project.machine_id}</p>)}
      <form className="factory-form" onSubmit={(event) => { event.preventDefault(); void perform(async () => { await factoryRequest("/projects", { name: projectName, path: projectPath, provider: projectProvider, machine_id: projectMachine, tracker: "app" }); setProjectName(""); setProjectPath(""); }); }}>
        <label>{t("Project name")}<input className="input" value={projectName} onChange={(event) => setProjectName(event.target.value)} required maxLength={200} /></label>
        <label>{t("Checkout path")}<input className="input" value={projectPath} onChange={(event) => setProjectPath(event.target.value)} required /></label>
        <label>{t("Provider")}<select className="select" value={projectProvider} onChange={(event) => setProjectProvider(event.target.value as FactoryProvider)}><option>codex</option><option>claude</option><option>opencode</option></select></label>
        <label>{t("Machine")}<select className="select" value={projectMachine} onChange={(event) => setProjectMachine(event.target.value)}><option value="local">{t("This PC")}</option>{machines.filter((machine) => machine.id !== "local").map((machine) => <option key={machine.id} value={machine.id}>{machine.name}</option>)}</select></label>
        <button className="btn" disabled={busy}>{t("Register Project")}</button>
      </form></section>}
    {!selected && overview && <>
      <form className="factory-form factory-capture" onSubmit={(event) => void capture(event)}>
        <label>{t("Idea title")}<input className="input" value={title} onChange={(event) => setTitle(event.target.value)} required maxLength={200} /></label>
        <label>{t("Idea notes")}<textarea className="input" value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={100_000} /></label>
        <button className="btn btn-primary" disabled={busy}>{t("Capture idea")}</button>
      </form>
      <div className="factory-filters">
        <label>{t("Run condition")}<select className="select" value={conditionFilter} onChange={(event) => setConditionFilter(event.target.value)}><option value="all">{t("All conditions")}</option>{["needs_you", "blocked", "disconnected", "interrupted", "working", "completed", "cancelled", "failed"].map((condition) => <option key={condition} value={condition}>{condition}</option>)}</select></label>
        <label>{t("Project")}<select className="select" value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)}><option value="all">{t("All Projects")}</option><option value="unassigned">{t("Unassigned")}</option>{overview.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
        <label>{t("Provider")}<select className="select" value={providerFilter} onChange={(event) => setProviderFilter(event.target.value)}><option value="all">{t("All providers")}</option><option>codex</option><option>claude</option><option>opencode</option></select></label>
        <label>{t("Machine")}<select className="select" value={machineFilter} onChange={(event) => setMachineFilter(event.target.value)}><option value="all">{t("All Machines")}</option>{machines.map((machine) => <option key={machine.id} value={machine.id}>{machine.name}</option>)}{!machines.some((machine) => machine.id === "local") && <option value="local">{t("This PC")}</option>}</select></label>
      </div>
      <div className="factory-board">{stages.map((stage) => <section className="factory-lane" key={stage} aria-label={stageLabel(stage, t)}><h2>{stageLabel(stage, t)}</h2>
        {overview.implementations.filter((item) => item.stage === stage && (conditionFilter === "all" || overview.activity.some((activity) => activity.implementation_id === item.id && activity.condition === conditionFilter)) && (projectFilter === "all" || (item.project_id ?? "unassigned") === projectFilter) && (providerFilter === "all" || (item.provider ?? overview.projects.find((project) => project.id === item.project_id)?.provider ?? overview.settings.provider) === providerFilter) && (machineFilter === "all" || (item.machine_id ?? overview.projects.find((project) => project.id === item.project_id)?.machine_id ?? "local") === machineFilter)).map((item) => <article className="factory-card" key={item.id} draggable onDragStart={(event) => event.dataTransfer.setData("application/x-saurons-eye-card", item.id)} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const id = event.dataTransfer.getData("application/x-saurons-eye-card"); if (overview.implementations.some((entry) => entry.id === id) && id !== item.id) void perform(async () => { await factoryRequest(`/implementations/${id}/order`, { before_id: item.id }); }); }}>
          <button className="factory-card-title" onClick={() => choose(item.id)}>{item.title}</button><p>{overview.projects.find((project) => project.id === item.project_id)?.name ?? t("Unassigned")}</p><small>{item.provider ?? overview.projects.find((project) => project.id === item.project_id)?.provider ?? overview.settings.provider} · {item.machine_id ?? overview.projects.find((project) => project.id === item.project_id)?.machine_id ?? t("Unassigned")}</small><time>{new Date(item.updated_at).toLocaleString()}</time>
          {overview.activity.filter((activity) => activity.implementation_id === item.id).map((activity) => <p key={activity.run_id}>{activity.action} · {activity.condition} · {activity.completed_tickets}/{activity.total_tickets}{activity.waiting_reason && <span role="status"> · {activity.waiting_reason}</span>}</p>)}
          <div className="factory-card-order"><button className="icon-button" aria-label={t("Move earlier")} onClick={() => void perform(async () => { await factoryRequest(`/implementations/${item.id}/order`, { direction: -1 }); })}><ArrowUp /></button><button className="icon-button" aria-label={t("Move later")} onClick={() => void perform(async () => { await factoryRequest(`/implementations/${item.id}/order`, { direction: 1 }); })}><ArrowDown /></button></div>
        </article>)}
      </section>)}</div>
    </>}
    {selected && detail && overview && <div className="factory-detail">
      <section className="factory-section"><h2>{detail.implementation.title}</h2><p>{stageLabel(detail.implementation.stage, t)}</p>
        <div className="factory-filters">
          <label>{t("Project")}<select className="select" value={detail.implementation.project_id ?? ""} disabled={busy} onChange={(event) => void perform(async () => { await factoryRequest(`${prefix}/configure`, { project_id: event.target.value || null }); })}><option value="">{t("Unassigned")}</option>{overview.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
          <label>{t("Provider")}<select className="select" value={detail.implementation.provider ?? ""} disabled={busy} onChange={(event) => void perform(async () => { await factoryRequest(`${prefix}/configure`, { provider: event.target.value || null }); })}><option value="">{t("Project default")}</option><option>codex</option><option>claude</option><option>opencode</option></select></label>
          <label>{t("Machine")}<select className="select" value={detail.implementation.machine_id ?? ""} disabled={busy} onChange={(event) => void perform(async () => { await factoryRequest(`${prefix}/configure`, { machine_id: event.target.value || null }); })}><option value="">{t("Project default")}</option><option value="local">{t("This PC")}</option>{machines.filter((machine) => machine.id !== "local").map((machine) => <option key={machine.id} value={machine.id}>{machine.name}</option>)}</select></label>
        </div><p className="factory-context">{effectiveProvider} · {machines.find((machine) => machine.id === effectiveMachine)?.name ?? effectiveMachine} · {checkout?.path ?? t("No verified checkout")}</p>
      </section>
      <FactoryWorkflowPanel detail={detail} machineId={effectiveMachine} provider={effectiveProvider ?? "codex"} busy={busy} perform={perform} />
      {selectedProject && <FactoryProjectSettings key={`${selectedProject.id}:${effectiveMachine}`} project={selectedProject} overview={overview} machineId={effectiveMachine} busy={busy} perform={perform} />}
      <FactoryExecutionPanel detail={detail} project={selectedProject} busy={busy} perform={perform} onOpenPane={onOpenPane} />
      <section className="factory-section"><h3>{t("Notes")}</h3><label>{t("Chat")}<select className="select" value={chatId} onChange={(event) => setSelectedChat(event.target.value)}>{detail.chats.map((chat) => <option key={chat.id} value={chat.id}>{chat.title}</option>)}</select></label><form className="factory-form" onSubmit={(event) => { event.preventDefault(); void perform(async () => { const chat = await factoryRequest<{ id: string }>(`${prefix}/chats`, { title: chatTitle }); setSelectedChat(chat.id); setChatTitle(""); }); }}><label>{t("Chat title")}<input className="input" required maxLength={200} value={chatTitle} onChange={(event) => setChatTitle(event.target.value)} /></label><button className="btn" disabled={busy}>{t("New chat")}</button></form>{detail.messages.filter((message) => message.chat_id === chatId).map((message) => <article className="factory-message" key={message.id}><small>{message.role} · {new Date(message.created_at).toLocaleString()}</small><Markdown>{message.content}</Markdown></article>)}
        <form className="factory-form" onSubmit={(event) => { event.preventDefault(); void perform(async () => { await factoryRequest(`${prefix}/messages`, { chat_id: chatId, role: "owner", content: note }); setNote(""); }); }}><label>{t("New note")}<textarea className="input" value={note} onChange={(event) => setNote(event.target.value)} required maxLength={100_000} /></label><button className="btn" disabled={busy}>{t("Save note")}</button></form>
      </section>
      <section className="factory-section"><h3>{t("Attachments")}</h3><input ref={fileInput} type="file" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void attach(file); event.target.value = ""; }} /><button className="btn" disabled={busy} onClick={() => fileInput.current?.click()}><Paperclip aria-hidden="true" />{t("Add attachment")}</button>
        {detail.artifacts.map((artifact) => <article key={artifact.id} className="factory-artifact"><h4>{artifact.name} · v{artifact.version}</h4><small>{artifact.size.toLocaleString()} B · {artifact.origin}</small><form className="factory-form" onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget); void perform(async () => { await factoryRequest(`/artifacts/${artifact.id}/note`, { note: data.get("note") }); }); }}><label>{t("Attachment annotation")}<textarea className="input" name="note" defaultValue={artifact.note} maxLength={10000} /></label><button className="btn" disabled={busy}>{t("Save annotation")}</button><button type="button" className="btn" disabled={busy} onClick={() => void perform(async () => { await factoryRequest(`/artifacts/${artifact.id}/delete`, { hash: artifact.hash }); })}>{t("Delete attachment version")}</button></form>
          <div className="factory-actions"><button className="btn" onClick={() => void perform(async () => { const response = await fetch(`/api/factory/artifacts/${artifact.id}/download`); if (!response.ok) throw new Error(t("Attachment unavailable")); const url = URL.createObjectURL(await response.blob()); const link = document.createElement("a"); link.href = url; link.download = artifact.name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); })}>{t("Download")}</button><button className="btn" onClick={() => void perform(async () => { const response = await fetch(`/api/factory/artifacts/${artifact.id}/source`); if (!response.ok) throw new Error(t("Attachment unavailable")); setSource({ id: artifact.id, content: await response.text() }); })}>{t("Source")}</button></div>
          {(artifact.media_type === "text/html" || artifact.media_type.startsWith("image/")) && <FactoryArtifactPreview artifact={artifact} />}
          {(artifact.media_type === "text/markdown" || artifact.media_type === "text/plain") && <button className="btn" onClick={() => void perform(async () => { const response = await fetch(`/api/factory/artifacts/${artifact.id}/source`); if (!response.ok) throw new Error(t("Attachment unavailable")); setSource({ id: artifact.id, content: await response.text() }); })}>{t("Preview")}</button>}
          {source?.id === artifact.id && (artifact.media_type === "text/markdown" ? <Markdown>{source.content}</Markdown> : <pre>{source.content}</pre>)}
        </article>)}
      </section>
      <section className="factory-section"><h3>{t("Specification")}</h3><label>{t("Testing seams")}<textarea className="input" value={testingSeams} onChange={(event) => setTestingSeams(event.target.value)} /></label>{currentSpec && <><p>{t("Revision {revision}", { revision: currentSpec.revision })}</p><Markdown>{currentSpec.content}</Markdown><div className="factory-actions"><button className="btn" disabled={busy || detail.approvals.some((approval) => approval.kind === "specification" && approval.revision === currentSpec.id)} onClick={() => void perform(async () => { await factoryRequest(`${prefix}/approvals`, { kind: "specification", revision: currentSpec.id, scope: `Specification ${currentSpec.id}, SHA-256 ${currentSpec.hash}` }); })}>{t("Accept specification")}</button><button className="btn" disabled={busy} onClick={() => void perform(async () => { await factoryRequest(`${prefix}/approvals`, { kind: "testing_seams", revision: currentSpec.id, scope: testingSeams }); })}>{t("Confirm testing seams")}</button></div></>}
        <form className="factory-form" onSubmit={(event) => { event.preventDefault(); void perform(async () => { await factoryRequest(`${prefix}/specifications`, { content: specification }); setSpecification(""); }); }}><label>{t("Specification text")}<textarea className="input" value={specification} onChange={(event) => setSpecification(event.target.value)} required maxLength={250_000} /></label><button className="btn" disabled={busy}>{t("Save new revision")}</button></form>
      </section>
      <section className="factory-section"><h3>{t("Tickets")}</h3>{detail.tickets.map((ticket) => <article className="factory-message" key={ticket.id}><strong>{ticket.title}</strong><p>{ticket.acceptance}</p><small>{ticket.status} · {ticket.dependencies.length} {t("Dependencies")}</small></article>)}
        {detail.tickets.length > 0 && <button className="btn" disabled={busy} onClick={() => void perform(async () => { await factoryRequest(`${prefix}/approvals`, { kind: "ticket_graph", revision: detail.graph_hash, scope: `Ticket graph ${detail.graph_hash}; ${detail.tickets.map((ticket) => ticket.id).join(", ")}` }); })}>{t("Approve Ticket graph")}</button>}
        {currentSpec && <form className="factory-form" onSubmit={(event) => { event.preventDefault(); void perform(async () => { await factoryRequest(`${prefix}/tickets`, { specification_id: currentSpec.id, tickets }); }); }}>{tickets.map((ticket, index) => <fieldset key={ticket.key}><legend>{ticket.key}</legend><label>{t("Ticket title")}<input className="input" value={ticket.title} required onChange={(event) => setTickets((rows) => rows.map((row, position) => position === index ? { ...row, title: event.target.value } : row))} /></label><label>{t("Acceptance criteria")}<textarea className="input" value={ticket.acceptance} required onChange={(event) => setTickets((rows) => rows.map((row, position) => position === index ? { ...row, acceptance: event.target.value } : row))} /></label><label>{t("Dependencies")}<select className="select" multiple value={ticket.dependencies} onChange={(event) => { const dependencies = Array.from(event.target.selectedOptions, (option) => option.value); setTickets((rows) => rows.map((row, position) => position === index ? { ...row, dependencies } : row)); }}>{tickets.filter((row) => row.key !== ticket.key).map((row) => <option key={row.key} value={row.key}>{row.key} · {row.title}</option>)}</select></label></fieldset>)}<div className="factory-actions"><button type="button" className="btn" onClick={() => setTickets((rows) => [...rows, { key: `t${rows.length + 1}`, title: "", acceptance: "", dependencies: [] }])}><Plus aria-hidden="true" />{t("Add Ticket")}</button><button className="btn" disabled={busy}>{t("Propose Tickets")}</button></div></form>}
      </section>
      <section className="factory-section"><h3>{t("Run history")}</h3>{detail.runs.map((run) => <article className="factory-message" key={run.id}><strong>{run.action}</strong><p>{run.provider} · {run.machine_id} · {run.condition}</p>{run.waiting_reason && <p role="status">{run.waiting_reason}</p>}<div className="factory-actions">{run.pane_id && <button className="btn" onClick={() => onOpenPane(run.machine_id, run.pane_id!)}>{t("Open agent")}</button>}<button className="btn" disabled={busy} onClick={() => void perform(async () => { await factoryRequest(`/runs/${run.id}/reconcile`, {}); })}>{t("Reconcile Run")}</button><button className="btn" disabled={busy} onClick={() => void perform(async () => { await factoryRequest(`/runs/${run.id}/import-conversation`, {}); })}>{t("Retain native conversation")}</button><button className="btn" disabled={busy} onClick={() => void perform(async () => { await factoryRequest(`/runs/${run.id}/import-artifacts`, {}); })}>{t("Import research outputs")}</button><button className="btn" disabled={busy || ["cancelled", "completed"].includes(run.condition)} onClick={() => void perform(async () => { await factoryRequest(`/runs/${run.id}/stop`, { summary: "Owner stopped this attempt" }); })}>{t("Stop Run")}</button><button className="btn" disabled={busy || !["completed", "cancelled", "failed"].includes(run.condition)} onClick={() => void perform(async () => { await factoryRequest(`/runs/${run.id}/cleanup`, {}); })}>{t("Remove clean checkout")}</button></div></article>)}</section>
      <FactoryReviewPanel detail={detail} busy={busy} perform={perform} /><FactoryRetrospectivePanel detail={detail} busy={busy} perform={perform} />
      <section className="factory-section"><h3>{t("Retained native conversations")}</h3>{detail.native_snapshots.map((snapshot) => <details key={snapshot.id}><summary>{snapshot.run_id} · {snapshot.sequence} · {new Date(snapshot.created_at).toLocaleString()}</summary>{snapshot.turns.map((turn, index) => <article className="factory-message" key={index}><small>{turn.role} · {turn.ts}</small>{turn.parts.map((part, index) => part.kind === "text" ? <Markdown key={index}>{part.text}</Markdown> : part.kind === "skill" ? <small key={index}>{part.skill.name} · {part.skill.status}</small> : part.kind === "tool" ? <details key={index}><summary>{part.name} · {part.summary}</summary><pre>{part.output}</pre></details> : null)}</article>)}{snapshot.cursor && <button className="btn" disabled={busy} onClick={() => void perform(async () => { await factoryRequest(`/runs/${snapshot.run_id}/import-conversation`, { before: snapshot.cursor }); })}>{t("Retain older native history")}</button>}</details>)}</section>
      <section className="factory-section"><h3>{t("History")}</h3>{detail.events.map((event) => <p key={event.id}><time>{new Date(event.created_at).toLocaleString()}</time> · {event.kind}</p>)}</section>
    </div>}
  </section></OpenFileContext.Provider>;
}
