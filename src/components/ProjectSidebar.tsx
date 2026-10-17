import { useEffect, useState } from "react";
import { ChevronRight, Folder, Plus, SquareTerminal } from "lucide-react";
import type { FactoryOverview } from "../../shared/factory.ts";
import type { OmoTask } from "../../shared/protocol.ts";
import { MachineContext } from "../lib/machineContext.tsx";
import { useMachineApi } from "../lib/machineContext.tsx";
import { projectPanes, type ProjectPane, type ProjectView } from "../lib/projectNavigation.ts";
import type { Machine } from "../../shared/machines.ts";
import { useT } from "../lib/i18n.ts";
import { AgentMark } from "./AgentMark.tsx";
import { displayPaneTitle, StatusBadge } from "./Sidebar.tsx";
import { paneStatus, rollupStatus } from "../lib/status.ts";
import { WorkflowConversationTree } from "./WorkflowConversations.tsx";
import "./ProjectSidebar.css";

export function ProjectSidebar({ overview, machines, error, onNavigate, onOpenPane, selectedMachineId, selectedPaneId }: { overview: FactoryOverview | null; machines: Machine[]; error: string | null; onNavigate: (view: ProjectView) => void; onOpenPane: (machineId: string, paneId: string) => void; selectedMachineId: string; selectedPaneId: string | null }) {
  const t = useT(); const rows = overview ? projectPanes(overview, machines) : [];
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => new Set());
  return <nav className="project-navigation" aria-label={t("Projects")}>
    <div className="project-navigation-heading"><button onClick={() => onNavigate({ kind: "projects" })}><Folder />{t("Projects")}</button><button className="icon-button" title={t("Register Project")} aria-label={t("Register Project")} onClick={() => onNavigate({ kind: "projects" })}><Plus /></button></div>
    {error && <p className="tree-state" role="alert">{error}</p>}
    {overview?.projects.filter((p) => !p.removed_at).map((project) => <div className="project-navigation-group" key={project.id}>
      <div className="project-navigation-heading"><button className={`icon-button project-navigation-toggle${collapsedProjects.has(project.id) ? "" : " is-open"}`} aria-label={t("Project chats for {name}", { name: project.name })} aria-expanded={!collapsedProjects.has(project.id)} aria-controls={`project-chats-${project.id}`} onClick={() => setCollapsedProjects((before) => { const next = new Set(before); if (next.has(project.id)) next.delete(project.id); else next.add(project.id); return next; })}><ChevronRight aria-hidden="true" /></button><button className="project-navigation-row" onClick={() => onNavigate({ kind: "project", id: project.id })}><Folder aria-hidden="true" /><span>{project.name}</span></button><StatusBadge compact showIdle status={rollupStatus(rows.filter(row=>row.projectId===project.id&&!row.archived&&!row.finished).map(row=>row.machine.state==="connected"?paneStatus(row.pane):undefined))}/></div><div id={`project-chats-${project.id}`} className="project-navigation-children" hidden={collapsedProjects.has(project.id)}>
      {overview.implementations.filter((i) => (i.project_id === project.id || rows.some((row) => row.projectId === project.id && row.link?.implementation_id === i.id)) && !i.archived_at && !overview.board?.some(item => item.implementation_id === i.id && item.sidebar_hidden === true)).map((idea) => <div className="project-assignment" key={idea.id}>
        <button className="project-navigation-row" onClick={() => onNavigate({ kind: "assignment", id: idea.id })}><AgentMark agent={idea.provider ?? project.provider} /><span>{idea.title}</span><small>{idea.stage}</small></button>
        <div className="project-navigation-children"><WorkflowConversationTree conversations={(overview.conversations ?? []).filter(c => c.implementation_id === idea.id)} onSelect={conversationId => onNavigate({ kind: "assignment", id: idea.id, conversationId })} renderContext={conversation => rows.filter(row => row.projectId === project.id && row.link?.implementation_id === idea.id && !row.archived && !row.finished && conversation.contexts.some(context => context.run_id === row.link?.run_id && context.worker_id === row.link?.worker_id)).map(row => <div className="project-navigation-children" key={`${row.machine.id}:${row.pane.pane_id}`}><ProjectPaneRow row={row} onOpenPane={onOpenPane} selected={selectedMachineId === row.machine.id && selectedPaneId === row.pane.pane_id} /></div>)} />{rows.filter((r) => r.projectId === project.id && r.link?.implementation_id === idea.id && !r.archived && !r.finished && !(overview.conversations ?? []).some(c => c.contexts.some(context => context.run_id === r.link?.run_id && context.worker_id === r.link?.worker_id))).map((row) => <ProjectPaneRow key={`${row.machine.id}:${row.pane.pane_id}`} row={row} onOpenPane={onOpenPane} selected={selectedMachineId === row.machine.id && selectedPaneId === row.pane.pane_id} />)}</div>
      </div>)}
      {rows.filter((r) => r.projectId === project.id && !r.link && !r.archived && !r.finished).map((row) => <ProjectPaneRow key={`${row.machine.id}:${row.pane.pane_id}`} row={row} onOpenPane={onOpenPane} selected={selectedMachineId === row.machine.id && selectedPaneId === row.pane.pane_id} />)}
      </div></div>)}
  </nav>;
}
function ProjectPaneRow({ row, selected, onOpenPane }: { row: ProjectPane; selected: boolean; onOpenPane: (machineId: string, paneId: string) => void }) {
  const t = useT(); const [expanded, setExpanded] = useState(false);
  return <div className="project-pane-row"><button className={`project-navigation-row${selected ? " is-selected" : ""}`} aria-current={selected ? "true" : undefined} title={`${row.machine.name} · ${row.pane.cwd ?? ""}`} onClick={() => onOpenPane(row.machine.id, row.pane.pane_id)}>
    {row.pane.agent || row.link?.provider ? <AgentMark agent={row.pane.agent ?? row.link!.provider} /> : <SquareTerminal />}<span>{row.link?.title ?? displayPaneTitle(row.pane)}</span><StatusBadge compact showIdle status={row.machine.state==="connected"?paneStatus(row.pane):undefined}/>
  </button>{(!!row.pane.background_tasks || ["claude", "omo"].includes(row.pane.agent ?? row.link?.provider ?? "")) && <><button className="project-navigation-row" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{t("Child tasks")}{!!row.pane.background_tasks && ` · ${row.pane.background_tasks}`}</button>{expanded && <MachineContext.Provider value={row.machine.id}><NativeChildren paneId={row.pane.pane_id} provider={row.pane.agent ?? ""} connected={row.machine.state === "connected"} onOpen={() => onOpenPane(row.machine.id, row.pane.pane_id)} /></MachineContext.Provider>}</>}</div>;
}
function NativeChildren({ paneId, provider, connected, onOpen }: { paneId: string; provider: string; connected: boolean; onOpen: () => void }) {
  const { fetchPaneOmoActivity } = useMachineApi(); const [tasks, setTasks] = useState<OmoTask[]>([]); const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true; let timer: ReturnType<typeof setTimeout>;
    if (!connected) return;
    const read = async () => { try { if (document.visibilityState === "visible") { const next = await fetchPaneOmoActivity(paneId); if (live) { setTasks(next.tasks); setError(null); } } } catch (e) { if (live) setError(e instanceof Error ? e.message : String(e)); } finally { if (live) timer = setTimeout(() => void read(), 10000); } };
    void read(); return () => { live = false; clearTimeout(timer); };
  }, [paneId, fetchPaneOmoActivity, connected]);
  return <div className="project-navigation-children">{connected && error && <p role="alert">{error}</p>}{tasks.map((task) => <button className="project-navigation-row" key={task.id} onClick={onOpen} title={task.model ?? undefined}><AgentMark agent={provider} /><span>{task.title}</span><StatusBadge compact showIdle status={!connected ? undefined : task.status==="running"?"working":task.status==="completed"?"done":task.status==="failed"?"blocked":undefined}/></button>)}</div>;
}
