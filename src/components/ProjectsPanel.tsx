import { useEffect, useRef, useState } from "react";
import { FolderOpen, RefreshCw } from "lucide-react";
import type { FactoryOverview, FactoryProject, FactoryProvider } from "../../shared/factory.ts";
import type { Machine } from "../../shared/machines.ts";
import { factoryRequest } from "../lib/factoryApi.ts";
import { MachineContext } from "../lib/machineContext.tsx";
import { useT } from "../lib/i18n.ts";
import { DirectoryBrowser } from "./DirectoryBrowser.tsx";
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
    {overview && !projectId && section === "general" && <><ProjectRegistration machines={machines} busy={busy} perform={perform} onProject={onProject} />
      <section className="factory-section"><h2>{t("Projects")}</h2>{overview.projects.filter((p) => !p.removed_at).map((p) => <p key={p.id}><button className="btn" onClick={() => onProject(p.id)}>{p.name}</button></p>)}</section>
      <details className="factory-section"><summary>{t("Archived chats")}</summary>{overview.pane_archives?.filter((a) => a.archived_at).map((a) => <p key={a.id}>{machines.find((m) => m.id === a.machine_id)?.name ?? a.machine_id} · {(() => { const pane = machines.find((m) => m.id === a.machine_id)?.snapshot?.panes.find((p) => p.pane_id === a.pane_id); return pane && pane.terminal_id === a.terminal_id ? displayPaneTitle(pane) : a.title ?? a.pane_id; })()} <button className="btn" disabled={busy} onClick={() => void perform(async () => { await factoryRequest("/pane-archives", { machine_id: a.machine_id, pane_id: a.pane_id, archived: false }); })}>{t("Restore chat")}</button></p>)}</details>
      <details className="factory-section"><summary>{t("Removed Projects")}</summary>{overview.projects.filter((p) => p.removed_at).map((p) => <p key={p.id}>{p.name} <button className="btn" disabled={busy} onClick={() => void perform(async () => { await factoryRequest(`/projects/${p.id}/restore`, {}); })}>{t("Restore")}</button></p>)}</details></>}
    {overview && !projectId && section === "factory" && <FactoryOperationsPanel overview={overview} busy={busy} perform={perform} />}
    {overview && project && <ProjectManagement section={section} key={`${project.id}:${project.removed_at ?? "active"}`} project={project} overview={overview} machines={machines} busy={busy} perform={perform} />}
    {overview && projectId && !project && <p role="alert">{t("Project not found")}</p>}
  </section>;
}

function ProjectRegistration({ machines, busy, perform, onProject }: { machines: Machine[]; busy: boolean; perform: (action: () => Promise<void>) => Promise<void>; onProject: (id: string) => void }) {
  const live = useRef(true); useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const t = useT(); const [name, setName] = useState(""); const [path, setPath] = useState(""); const [provider, setProvider] = useState<FactoryProvider>("codex");
  const [selection, setSelection] = useState(""); const machine = machines.find((m) => m.id === selection) ?? machines[0]; const [browse, setBrowse] = useState(false);
  return <section className="factory-section"><h2>{t("Register Project")}</h2><form className="factory-form" onSubmit={(event) => { event.preventDefault(); if (!machine) return; void perform(async () => { const project = await factoryRequest<FactoryProject>("/projects", { name, path, provider, machine_id: machine.id, tracker: "app" }); if (live.current) onProject(project.id); }); }}>
    <label>{t("Project name")}<input className="input" required maxLength={200} value={name} onChange={(event) => setName(event.target.value)} /></label>
    <label>{t("Machine")}<select className="select" required value={machine?.id ?? ""} onChange={(event) => { setSelection(event.target.value); setPath(""); setBrowse(false); }}>{machines.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
    <label>{t("Checkout path")}<input className="input" required value={path} onChange={(event) => setPath(event.target.value)} /></label>
    <button type="button" className="btn project-browse" disabled={!machine || machine.state !== "connected" || busy} aria-expanded={browse} onClick={() => setBrowse(!browse)}><FolderOpen />{t("Browse…")}</button>
    {browse && machine && <MachineContext.Provider value={machine.id}><DirectoryBrowser key={machine.id} start={path} absolute onPick={(next) => { setPath(next); setBrowse(false); }} /></MachineContext.Provider>}
    <label>{t("Provider")}<select className="select" value={provider} onChange={(event) => setProvider(event.target.value as FactoryProvider)}><option>codex</option><option>claude</option><option>opencode</option></select></label>
    <button className="btn btn-primary" disabled={busy || !machine || machine.state !== "connected"}>{t("Register Project")}</button>
  </form></section>;
}

function ProjectManagement({ project, overview, machines, busy, perform, section }:  { project: FactoryProject; overview: FactoryOverview; machines: Machine[]; busy: boolean; perform: (action: () => Promise<void>) => Promise<void> ; section: ProjectSettingsPage }) {
  const t = useT(); const [name, setName] = useState(project.name); const [confirm, setConfirm] = useState(false);
  const [selectedHost, setSelectedHost] = useState(project.machine_id);
  const host = machines.find((m) => m.id === selectedHost) ?? machines[0];
  if (project.removed_at) return <section className="factory-section"><p>{t("Project registration removed. History and native sessions are retained.")}</p><button className="btn" disabled={busy} onClick={() => void perform(async () => { await factoryRequest(`/projects/${project.id}/restore`, {}); })}>{t("Restore")}</button></section>;
  return <>
    {section === "general" && <section className="factory-section"><form className="factory-form" onSubmit={(event) => { event.preventDefault(); void perform(async () => { await factoryRequest(`/projects/${project.id}/configure`, { name }); }); }}><label>{t("Project name")}<input className="input" required maxLength={200} value={name} onChange={(event) => setName(event.target.value)} /></label><button className="btn" disabled={busy}>{t("Rename")}</button></form></section>}
    {section !== "general" && <section className="factory-section">{section !== "execution" && section !== "github" && <label>{t("Machine")}<select className="select" value={host?.id ?? ""} onChange={(event) => setSelectedHost(event.target.value)}>{machines.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>}
    {host && <>
      {(section === "execution" || section === "checkout") && <FactoryProjectSettings key={`${project.id}:${host.id}`} section={section} project={project} overview={overview} machineId={host.id} machines={machines} busy={busy} perform={perform} />}
      {section === "accounts" && <FactoryProjectAccounts key={`${project.id}:${host.id}`} project={project} machineId={host.id} busy={busy} perform={perform} />}
      {section === "references" && <FactoryProjectReferences key={`references:${project.id}:${host.id}`} project={project} machineId={host.id} maxBytes={overview.settings.max_artifact_bytes} busy={busy} perform={perform} />}
      {section === "github" && <FactoryProjectGitHub key={project.id} project={project} busy={busy} perform={perform} />}
    </>}</section>}
    {section === "general" && <section className="factory-section"><p>{t("Removing a Project preserves its history and leaves native sessions running.")}</p><button className={confirm ? "btn btn-danger" : "btn"} disabled={busy} onClick={() => { if (confirm) void perform(async () => { await factoryRequest(`/projects/${project.id}/remove`, {}); }); else setConfirm(true); }}>{confirm ? t("Confirm remove Project") : t("Remove Project")}</button>{confirm && <button className="btn" onClick={() => setConfirm(false)}>{t("Cancel")}</button>}</section>}
  </>;
}
