import { useState } from "react";
import type { FactoryOverview, FactoryProject, FactoryProvider } from "../../shared/protocol.ts";
import { factoryRequest } from "../lib/factoryApi.ts";
import { useT } from "../lib/i18n.ts";

export function FactoryProjectSettings({ project, overview, machineId, busy, perform }: { project: FactoryProject; overview: FactoryOverview; machineId: string; busy: boolean; perform: (action: () => Promise<void>) => Promise<void> }) {
  const t = useT();
  const [checks, setChecks] = useState(JSON.stringify(project.checks ?? [], null, 2));
  const [setup, setSetup] = useState(JSON.stringify(project.setup ?? [], null, 2));
  const [environment, setEnvironment] = useState(JSON.stringify(project.environment ?? {}, null, 2));
  const [permissions, setPermissions] = useState(project.permissions ?? "");
  const [provider, setProvider] = useState<FactoryProvider>(project.provider);
  const [defaultMachine, setDefaultMachine] = useState(project.machine_id);
  const [shared, setShared] = useState((project.shared_paths ?? []).join("\n"));
  const [path, setPath] = useState(overview.checkouts.find((entry) => entry.project_id === project.id && entry.machine_id === machineId)?.path ?? "");
  return <details className="factory-section"><summary>{t("Project execution settings")}</summary>
    <form className="factory-form" onSubmit={(event) => { event.preventDefault(); void perform(async () => { await factoryRequest(`/projects/${project.id}/configure`, { checks: JSON.parse(checks), setup: JSON.parse(setup), environment: JSON.parse(environment), permissions, provider, machine_id: defaultMachine, shared_paths: shared.split("\n").map((entry) => entry.trim()).filter(Boolean) }); }); }}>
      <label>{t("Provider")}<select className="select factory-input" value={provider} onChange={(event) => setProvider(event.target.value as FactoryProvider)}><option>codex</option><option>claude</option><option>opencode</option></select></label>
      <label>{t("Machine")}<select className="select factory-input" value={defaultMachine} onChange={(event) => setDefaultMachine(event.target.value)}>{overview.checkouts.filter((entry) => entry.project_id === project.id).map((entry) => <option key={entry.id} value={entry.machine_id}>{entry.machine_id}</option>)}</select></label>
      <label>{t("Check command arguments")}<textarea className="input factory-input" value={checks} onChange={(event) => setChecks(event.target.value)} /></label>
      <label>{t("Setup command arguments")}<textarea className="input factory-input" value={setup} onChange={(event) => setSetup(event.target.value)} /></label>
      <label>{t("Task environment")}<textarea className="input factory-input" value={environment} onChange={(event) => setEnvironment(event.target.value)} /></label>
      <label>{t("Execution permissions")}<textarea className="input factory-input" required value={permissions} onChange={(event) => setPermissions(event.target.value)} /></label>
      <label>{t("Shared document paths")}<textarea className="input factory-input" value={shared} onChange={(event) => setShared(event.target.value)} /></label>
      <button className="btn factory-button" disabled={busy}>{t("Save Project settings")}</button>
    </form>
    <form className="factory-form" onSubmit={(event) => { event.preventDefault(); void perform(async () => { await factoryRequest(`/projects/${project.id}/checkouts`, { machine_id: machineId, path }); }); }}>
      <label>{t("Checkout path")} · {machineId}<input className="input factory-input" required value={path} onChange={(event) => setPath(event.target.value)} /></label>
      <button className="btn factory-button" disabled={busy}>{t("Verify Machine checkout")}</button>
    </form>
  </details>;
}
