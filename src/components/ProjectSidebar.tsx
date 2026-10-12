import { useEffect, useState } from "react";
import { Folder, Inbox, MessageSquare, Plus, SquareTerminal, Settings } from "lucide-react";
import type { FactoryOverview } from "../../shared/factory.ts";
import type { OmoTask } from "../../shared/protocol.ts";
import { MachineContext } from "../lib/machineContext.tsx";
import { useMachineApi } from "../lib/machineContext.tsx";
import { projectPanes, type ProjectPane, type ProjectView } from "../lib/projectNavigation.ts";
import type { Machine } from "../../shared/machines.ts";
import { useT } from "../lib/i18n.ts";
import { AgentMark } from "./AgentMark.tsx";
import { displayPaneTitle } from "./Sidebar.tsx";
import "./ProjectSidebar.css";

export function ProjectSidebar({ overview, machines, error, onNavigate, onOpenPane, selectedMachineId, selectedPaneId }: { overview: FactoryOverview | null; machines: Machine[]; error: string | null; onNavigate: (view: ProjectView) => void; onOpenPane: (machineId: string, paneId: string) => void; selectedMachineId: string; selectedPaneId: string | null }) {
  const t = useT(); const rows = overview ? projectPanes(overview, machines) : [];
  return <nav className="project-navigation" aria-label={t("Projects")}>
    <div className="project-navigation-heading"><button onClick={() => onNavigate({ kind: "projects" })}><Folder />{t("Projects")}</button><button className="icon-button" title={t("Register Project")} aria-label={t("Register Project")} onClick={() => onNavigate({ kind: "projects" })}><Plus /></button></div>
    <button className="project-navigation-row" onClick={() => onNavigate({ kind: "inbox" })}><Inbox />{t("Inbox")}</button>
    <button className="project-navigation-row" onClick={() => onNavigate({ kind: "assignments" })}><SquareTerminal />{t("Assignments")}</button>
    {error && <p className="tree-state" role="alert">{error}</p>}
    {overview?.projects.filter((p) => !p.removed_at).map((project) => <details className="project-navigation-group" key={project.id} open>
      <summary><span>{project.name}</span></summary><div className="project-navigation-children">
      <div className="project-navigation-heading"><button className="project-navigation-row" onClick={() => onNavigate({ kind: "project", id: project.id })}><Folder />{project.name}</button><button className="icon-button" aria-label={t("Project settings for {name}", { name: project.name })} title={t("Project settings")} onClick={() => onNavigate({ kind: "project-settings", id: project.id })}><Settings /></button></div>
      <button className="project-navigation-row" onClick={() => onNavigate({ kind: "project-inbox", id: project.id })}><MessageSquare />{t("Inbox chat")}</button>
      <span className="project-navigation-label">{t("Assignments")}</span>
      {overview.implementations.filter((i) => (i.project_id === project.id || rows.some((row) => row.projectId === project.id && row.link?.implementation_id === i.id)) && !i.archived_at).map((idea) => <div className="project-assignment" key={idea.id}>
        <button className="project-navigation-row" onClick={() => onNavigate({ kind: "assignment", id: idea.id })}><AgentMark agent={idea.provider ?? project.provider} /><span>{idea.title}</span><small>{idea.stage}</small></button>
        <div className="project-navigation-children">{rows.filter((r) => r.projectId === project.id && r.link?.implementation_id === idea.id && !r.archived).map((row) => <ProjectPaneRow key={`${row.machine.id}:${row.pane.pane_id}`} row={row} onOpenPane={onOpenPane} selected={selectedMachineId === row.machine.id && selectedPaneId === row.pane.pane_id} />)}</div>
      </div>)}
      {rows.filter((r) => r.projectId === project.id && !r.link && !r.archived).map((row) => <ProjectPaneRow key={`${row.machine.id}:${row.pane.pane_id}`} row={row} onOpenPane={onOpenPane} selected={selectedMachineId === row.machine.id && selectedPaneId === row.pane.pane_id} />)}
      </div></details>)}
  </nav>;
}
function ProjectPaneRow({ row, selected, onOpenPane }: { row: ProjectPane; selected: boolean; onOpenPane: (machineId: string, paneId: string) => void }) {
  const t = useT(); const [expanded, setExpanded] = useState(false);
  return <div className="project-pane-row"><button className={`project-navigation-row${selected ? " is-selected" : ""}`} aria-current={selected ? "true" : undefined} title={`${row.machine.name} · ${row.pane.cwd ?? ""}`} onClick={() => onOpenPane(row.machine.id, row.pane.pane_id)}>
    {row.pane.agent || row.link?.provider ? <AgentMark agent={row.pane.agent ?? row.link!.provider} /> : <SquareTerminal />}<span>{row.link?.title ?? displayPaneTitle(row.pane)}</span><small role="status">{row.pane.agent_status}</small>
  </button>{(!!row.pane.background_tasks || ["claude", "omo"].includes(row.pane.agent ?? row.link?.provider ?? "")) && <><button className="project-navigation-row" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{t("Child tasks")}{!!row.pane.background_tasks && ` · ${row.pane.background_tasks}`}</button>{expanded && <MachineContext.Provider value={row.machine.id}><NativeChildren paneId={row.pane.pane_id} provider={row.pane.agent ?? ""} onOpen={() => onOpenPane(row.machine.id, row.pane.pane_id)} /></MachineContext.Provider>}</>}</div>;
}
function NativeChildren({ paneId, provider, onOpen }: { paneId: string; provider: string; onOpen: () => void }) {
  const { fetchPaneOmoActivity } = useMachineApi(); const [tasks, setTasks] = useState<OmoTask[]>([]); const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true; let timer: ReturnType<typeof setTimeout>;
    const read = async () => { try { if (document.visibilityState === "visible") { const next = await fetchPaneOmoActivity(paneId); if (live) { setTasks(next.tasks); setError(null); } } } catch (e) { if (live) setError(e instanceof Error ? e.message : String(e)); } finally { if (live) timer = setTimeout(() => void read(), 10000); } };
    void read(); return () => { live = false; clearTimeout(timer); };
  }, [paneId, fetchPaneOmoActivity]);
  return <div className="project-navigation-children">{error && <p role="alert">{error}</p>}{tasks.map((task) => <button className="project-navigation-row" key={task.id} onClick={onOpen} title={task.model ?? undefined}><AgentMark agent={provider} /><span>{task.title}</span><small role="status">{task.status}</small></button>)}</div>;
}
