import { useState } from "react";
import { RefreshCw } from "lucide-react";
import type { FactoryOverview, FactoryProject } from "../../shared/factory.ts";
import type { Machine } from "../../shared/machines.ts";
import { factoryRequest } from "../lib/factoryApi.ts";
import { useT } from "../lib/i18n.ts";
import { ProjectSetupWizard } from "./ProjectSetupWizard.tsx";
import { FactoryProjectSettings } from "./FactoryProjectSettings.tsx";
import { FactoryProjectAccounts } from "./FactoryProjectAccounts.tsx";
import { FactoryProjectGitHub } from "./FactoryProjectGitHub.tsx";
import { FactoryOperationsPanel } from "./FactoryOperationsPanel.tsx";
import { displayPaneTitle } from "./Sidebar.tsx";
import { FactoryProjectReferences } from "./FactoryProjectReferences.tsx";
import "./FactoryPanel.css";
import "./ProjectsPanel.css";

export type ProjectSettingsPage = "general" | "execution" | "checkout" | "accounts" | "references" | "github" | "factory";

export function ProjectsPanel({ overview, machines, projectId, refresh, onProject, section = "general", embedded = false }: { overview: FactoryOverview | null; machines: Machine[]; projectId: string | null; refresh: () => Promise<void>; onProject: (id: string | null) => void; section?: ProjectSettingsPage; embedded?: boolean }) {
  const t = useT(); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  async function perform(action: () => Promise<void>) { if (busy) return; setBusy(true); setError(null); try { await action(); await refresh(); } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); } finally { setBusy(false); } }
  const project = overview?.projects.find((p) => p.id === projectId);
  return <section className={`factory-panel${embedded ? " project-settings-content" : ""}`} aria-label={t("Projects")}>
    {!embedded && <div className="factory-heading"><h1>{project?.name ?? t("Projects")}</h1>{projectId && <button className="btn" onClick={() => onProject(null)}>{t("Projects")}</button>}<button className="icon-button" aria-label={t("Refresh factory")} disabled={busy} onClick={() => void perform(refresh)}><RefreshCw /></button></div>}
    {error && <p role="alert">{error}</p>}{!overview && <p role="status">{t("Loading…")}</p>}
    {overview && !projectId && section === "general" && <><ProjectSetupWizard machines={machines} busy={busy} perform={perform} onProject={onProject} />
      <section className="factory-section"><h2>{t("Projects")}</h2>{overview.projects.filter((p) => !p.removed_at).map((p) => <p key={p.id}><button className="btn" onClick={() => onProject(p.id)}>{p.name}</button></p>)}</section>
      <details className="factory-section"><summary>{t("Archived chats")}</summary>{overview.pane_archives?.filter((a) => a.archived_at).map((a) => <p key={a.id}>{machines.find((m) => m.id === a.machine_id)?.name ?? a.machine_id} · {(() => { const pane = machines.find((m) => m.id === a.machine_id)?.snapshot?.panes.find((p) => p.pane_id === a.pane_id); return pane && pane.terminal_id === a.terminal_id ? displayPaneTitle(pane) : a.title ?? a.pane_id; })()} <button className="btn" disabled={busy} onClick={() => void perform(async () => { await factoryRequest("/pane-archives", { machine_id: a.machine_id, pane_id: a.pane_id, archived: false }); })}>{t("Restore chat")}</button></p>)}</details>
      <details className="factory-section"><summary>{t("Removed Projects")}</summary>{overview.projects.filter((p) => p.removed_at).map((p) => <p key={p.id}>{p.name} <button className="btn" disabled={busy} onClick={() => void perform(async () => { await factoryRequest(`/projects/${p.id}/restore`, {}); })}>{t("Restore")}</button></p>)}</details></>}
    {overview && !projectId && section === "factory" && <FactoryOperationsPanel overview={overview} busy={busy} perform={perform} />}
    {overview && project && <ProjectManagement section={section} key={`${project.id}:${project.removed_at ?? "active"}`} project={project} overview={overview} machines={machines} busy={busy} perform={perform} />}
    {overview && projectId && !project && <p role="alert">{t("Project not found")}</p>}
  </section>;
}


function ProjectManagement({ project, overview, machines, busy, perform, section }:  { project: FactoryProject; overview: FactoryOverview; machines: Machine[]; busy: boolean; perform: (action: () => Promise<void>) => Promise<void> ; section: ProjectSettingsPage }) {
  const t = useT(); const [name, setName] = useState(project.name); const [confirm, setConfirm] = useState(false);
  const [selectedHost, setSelectedHost] = useState(project.machine_id);
  const host = machines.find((m) => m.id === selectedHost);
  if (project.removed_at) return <section className="factory-section"><p>{t("Project registration removed. History and native sessions are retained.")}</p><button className="btn" disabled={busy} onClick={() => void perform(async () => { await factoryRequest(`/projects/${project.id}/restore`, {}); })}>{t("Restore")}</button></section>;
  return <>
    {section === "general" && <section className="factory-section"><form className="factory-form" onSubmit={(event) => { event.preventDefault(); void perform(async () => { await factoryRequest(`/projects/${project.id}/configure`, { name }); }); }}><label>{t("Project name")}<input className="input" required maxLength={200} value={name} onChange={(event) => setName(event.target.value)} /></label><button className="btn" disabled={busy}>{t("Rename")}</button></form></section>}
    {section === "general" && <section className="factory-section"><h3>{t("Repository guidance")}</h3><p>{t("Use Matt Pocock skills to develop the glossary and coding standards with the owner.")}</p>{project.guidance_assignment_id ? <a className="btn" href={`#factory/${project.guidance_assignment_id}`}>{t("Open guidance setup")}</a> : <button className="btn" disabled={busy} onClick={()=>void perform(async()=>{await factoryRequest(`/projects/${project.id}/guidance`,{});})}>{t("Set up repository guidance")}</button>}</section>}
    {section !== "general" && <section className="factory-section">{section !== "execution" && section !== "github" && <label>{t("Machine")}<select className="select" value={host?.id ?? ""} onChange={(event) => setSelectedHost(event.target.value)}><option value="" disabled>{t("Select a Machine")}</option>{machines.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>}
    {section === "execution" && <FactoryProjectSettings key={`${project.id}:execution`} section="execution" project={project} overview={overview} machineId={selectedHost} machines={machines} busy={busy} perform={perform} />}
    {section === "github" && <FactoryProjectGitHub key={project.id} project={project} checkoutPath={overview.checkouts.find(c=>c.project_id===project.id&&c.machine_id==="local")?.path} machineName={machines.find(m=>m.id==="local")?.name} busy={busy} perform={perform} />}
    {host && <>
      {section === "checkout" && <FactoryProjectSettings key={`${project.id}:${host.id}`} section="checkout" project={project} overview={overview} machineId={host.id} machines={machines} busy={busy} perform={perform} />}
      {section === "accounts" && <FactoryProjectAccounts key={`${project.id}:${host.id}`} project={project} machineId={host.id} checkoutPath={overview.checkouts.find(c=>c.project_id===project.id&&c.machine_id===host.id)?.path} busy={busy} perform={perform} />}
      {section === "references" && <FactoryProjectReferences key={`references:${project.id}:${host.id}`} project={project} machineId={host.id} maxBytes={overview.settings.max_artifact_bytes} busy={busy} perform={perform} />}
    </>}</section>}
    {section === "general" && <section className="factory-section"><p>{t("Removing a Project preserves its history and leaves native sessions running.")}</p><button className={confirm ? "btn btn-danger" : "btn"} disabled={busy} onClick={() => { if (confirm) void perform(async () => { await factoryRequest(`/projects/${project.id}/remove`, {}); }); else setConfirm(true); }}>{confirm ? t("Confirm remove Project") : t("Remove Project")}</button>{confirm && <button className="btn" onClick={() => setConfirm(false)}>{t("Cancel")}</button>}</section>}
  </>;
}
