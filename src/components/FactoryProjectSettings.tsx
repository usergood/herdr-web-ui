import { useState } from "react";
import type { Machine } from "../../shared/machines.ts";
import { DirectoryBrowser } from "./DirectoryBrowser.tsx";
import { MachineContext } from "../lib/machineContext.tsx";
import type { FactoryOverview, FactoryProject, FactoryProvider } from "../../shared/protocol.ts";
import { factoryRequest } from "../lib/factoryApi.ts";
import { useT } from "../lib/i18n.ts";
import { FactoryProjectAccounts } from "./FactoryProjectAccounts.tsx";
import { FactoryProjectGitHub } from "./FactoryProjectGitHub.tsx";

export function FactoryProjectSettings({ project, overview, machineId, machines, busy, perform }: { project: FactoryProject; overview: FactoryOverview; machineId: string; machines: Machine[]; busy: boolean; perform: (action: () => Promise<void>) => Promise<void> }) {
  const t = useT();
  const [checks, setChecks] = useState(JSON.stringify(project.checks ?? [], null, 2));
  const [setup, setSetup] = useState(JSON.stringify(project.setup ?? [], null, 2));
  const [environment, setEnvironment] = useState(JSON.stringify(project.environment ?? {}, null, 2));
  const [permissions, setPermissions] = useState(project.permissions ?? "");
  const [provider, setProvider] = useState<FactoryProvider>(project.provider);
  const [defaultMachine, setDefaultMachine] = useState(project.machine_id);
  const [shared, setShared] = useState((project.shared_paths ?? []).join("\n"));
  const [path, setPath] = useState(overview.checkouts.find((entry) => entry.project_id === project.id && entry.machine_id === machineId)?.path ?? "");
  const [browse, setBrowse] = useState(false);
  const [workflow, setWorkflow] = useState(project.workflow_instructions ?? "");
  const [contextTarget, setContextTarget] = useState(project.context_target_tokens ?? 150000);
  return <details className="factory-section"><summary>{t("Project execution settings")}</summary>
    <form className="factory-form" onSubmit={(event) => { event.preventDefault(); void perform(async () => { await factoryRequest(`/projects/${project.id}/configure`, { checks: JSON.parse(checks), setup: JSON.parse(setup), environment: JSON.parse(environment), permissions, provider, machine_id: defaultMachine, workflow_instructions: workflow, context_target_tokens: contextTarget, shared_paths: shared.split("\n").map((entry) => entry.trim()).filter(Boolean) }); }); }}>
      <label>{t("Provider")}<select className="select factory-input" value={provider} onChange={(event) => setProvider(event.target.value as FactoryProvider)}><option>codex</option><option>claude</option><option>opencode</option></select></label>
      <label>{t("Machine")}<select className="select factory-input" value={defaultMachine} onChange={(event) => setDefaultMachine(event.target.value)}>{machines.filter((machine) => overview.checkouts.some((entry) => entry.project_id === project.id && entry.machine_id === machine.id)).map((machine) => <option key={machine.id} value={machine.id}>{machine.name}</option>)}</select></label>
      <label>{t("Check command arguments")}<textarea className="input factory-input" value={checks} onChange={(event) => setChecks(event.target.value)} /></label>
      <label>{t("Setup command arguments")}<textarea className="input factory-input" value={setup} onChange={(event) => setSetup(event.target.value)} /></label>
      <label>{t("Task environment")}<textarea className="input factory-input" value={environment} onChange={(event) => setEnvironment(event.target.value)} /></label>
      <label>{t("Execution permissions")}<textarea className="input factory-input" required value={permissions} onChange={(event) => setPermissions(event.target.value)} /></label>
      <label>{t("Shared document paths")}<textarea className="input factory-input" value={shared} onChange={(event) => setShared(event.target.value)} /></label>
      <label>{t("Project workflow instructions")}<textarea className="input factory-input" maxLength={20000} value={workflow} onChange={(event) => setWorkflow(event.target.value)} /></label>
      <p className="field-hint">{t("Pinned skills, approved Tickets, checks and independent reviews remain required.")}</p>
      <label>{t("Context handoff target")}<input className="input" type="number" min={150000} max={200000} step={1000} value={contextTarget} onChange={(event) => setContextTarget(Number(event.target.value))} /></label>
      <p className="field-hint">{t("A planning target for smaller Ticket workers, not a measured hard token limit.")}</p>
      <button className="btn factory-button" disabled={busy}>{t("Save Project settings")}</button>
    </form>
    <form className="factory-form" onSubmit={(event) => { event.preventDefault(); void perform(async () => { await factoryRequest(`/projects/${project.id}/checkouts`, { machine_id: machineId, path }); }); }}>
      <label>{t("Checkout path")} · {machines.find((m) => m.id === machineId)?.name ?? machineId}<input className="input factory-input" required value={path} onChange={(event) => setPath(event.target.value)} /></label>
      <button type="button" className="btn" disabled={busy || machines.find((m) => m.id === machineId)?.state !== "connected"} aria-expanded={browse} onClick={() => setBrowse(!browse)}>{t("Browse…")}</button>
      {browse && <MachineContext.Provider value={machineId}><DirectoryBrowser key={machineId} start={path} absolute onPick={(next) => { setPath(next); setBrowse(false); }} /></MachineContext.Provider>}
      <button className="btn factory-button" disabled={busy}>{t("Verify Machine checkout")}</button>
    </form>
    <FactoryProjectAccounts key={`${project.id}:${machineId}`} project={project} machineId={machineId} busy={busy} perform={perform} />
    <FactoryProjectGitHub key={project.id} project={project} busy={busy} perform={perform} />
  </details>;
}
