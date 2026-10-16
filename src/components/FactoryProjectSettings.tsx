import { useEffect, useRef, useState } from "react";
import type { Machine } from "../../shared/machines.ts";
import type { FactoryOverview, FactoryProject, FactoryProvider } from "../../shared/factory.ts";
import { AGENT_PERMISSION_MODES, type AgentPermissionMode } from "../../shared/agent-permissions.ts";
import { MATT_PROJECT_WORKFLOW, type ProjectCheckChoice, type ProjectDiscovery } from "../../shared/project-setup.ts";
import { factoryRequest } from "../lib/factoryApi.ts";
import { useT } from "../lib/i18n.ts";
import { ProjectFolderPicker } from "./ProjectFolderPicker.tsx";
import { ProjectPermissions } from "./ProjectPermissions.tsx";
import { ProjectChecks } from "./ProjectChecks.tsx";
import { AgentModelPicker } from "./AgentModelPicker.tsx";

const existingCheckId = (args: string[]) => `existing:${JSON.stringify(args)}`;

export function FactoryProjectSettings({ project, overview, machineId, machines, busy, perform, section = "execution" }: { project: FactoryProject; overview: FactoryOverview; section?: "execution" | "checkout"; machineId: string; machines: Machine[]; busy: boolean; perform: (action: () => Promise<void>) => Promise<void> }) {
  const t = useT();
  const [provider, setProvider] = useState<FactoryProvider>(project.provider);
  const [mode, setMode] = useState<AgentPermissionMode>(project.permission_mode ?? "ask");
  const [target, setTarget] = useState(project.context_target_tokens ?? 150000);
  const [prRepository, setPrRepository] = useState(project.pull_request?.repository ?? "");
  const [prBranch, setPrBranch] = useState(project.pull_request?.base_branch ?? "main");
  const [milestone, setMilestone] = useState(project.delivery_policy ?? "merge");
  const publicationTouched = useRef(false);
  const [host, setHost] = useState(project.machine_id);
  const [path, setPath] = useState(overview.checkouts.find(c => c.project_id === project.id && c.machine_id === machineId)?.path ?? "");
  const [data, setData] = useState<ProjectDiscovery | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>((project.checks ?? []).map(existingCheckId));
  const [checksTouched, setChecksTouched] = useState(false);
  const modeTouched = useRef(false);
  const [preset, setPreset] = useState(project.execution_preset ?? { model: null, reasoning: null });
  const presetTouched = useRef(false);
  const hosts = machines.filter(m => overview.checkouts.some(c => c.project_id === project.id && c.machine_id === m.id));
  const selectedHost = hosts.some(m => m.id === host) ? host : "";
  const checkout = overview.checkouts.find(c => c.project_id === project.id && c.machine_id === (section === "execution" ? host : machineId));
  const choices: ProjectCheckChoice[] = [...(data?.checks ?? []), ...(project.checks ?? []).filter(args => !data?.checks.some(c => JSON.stringify(c.args) === JSON.stringify(args))).map(args => ({ id: existingCheckId(args), name: t("Existing check"), args }))];
  useEffect(() => {
    let live = true; setData(null); setProblem(null);
    if (!checkout) return;
    void factoryRequest<ProjectDiscovery>("/project-discovery", { machine_id: checkout.machine_id, path: checkout.path }).then(result => {
      if (!live) return;
      setData(result);
      const items = [...result.checks, ...(project.checks ?? []).filter(args => !result.checks.some(c => JSON.stringify(c.args) === JSON.stringify(args))).map(args => ({ id: existingCheckId(args), name: "", args }))];
      setSelected(project.checks?.length ? items.filter(c => project.checks!.some(args => JSON.stringify(args) === JSON.stringify(c.args))).map(c => c.id) : result.checks.map(c => c.id));
      if (!project.permission_mode && !modeTouched.current) setMode(provider === "codex" && result.permission_modes.codex.includes("approve_for_me") ? "approve_for_me" : "ask");
    }, error => { if (live) setProblem(error.message); });
    return () => { live = false; };
  }, [checkout?.machine_id, checkout?.path]);
  return <section className="factory-section"><h3>{section === "checkout" ? t("Verify Machine checkout") : t("Project execution settings")}</h3>
    {section === "execution" && <form className="factory-form" onSubmit={event => {
      event.preventDefault(); if (!selectedHost) return;
      void perform(async () => { await factoryRequest(`/projects/${project.id}/configure`, { delivery_policy: milestone, ...(publicationTouched.current ? { pull_request: prRepository.trim() ? { repository: prRepository.trim(), base_branch: prBranch.trim() } : null } : {}), provider, machine_id: selectedHost, permission_mode: mode, context_target_tokens: target, ...(presetTouched.current ? { execution_preset: preset } : {}), ...(data || checksTouched ? { checks: choices.filter(c => selected.includes(c.id)).map(c => c.args) } : {}), ...(!project.workflow_instructions?.trim() ? { workflow_instructions: MATT_PROJECT_WORKFLOW } : {}) }); });
    }}>
      <label>{t("CLI agent")}<select className="select" value={provider} onChange={event => { const next = event.target.value as FactoryProvider; setProvider(next); modeTouched.current = true; presetTouched.current = true; setPreset({ model: null, reasoning: null }); setMode(next === "codex" && data?.permission_modes.codex.includes("approve_for_me") ? "approve_for_me" : "ask"); }}><option>codex</option><option>claude</option><option>opencode</option></select></label>
      <label>{t("Machine")}<select className="select" value={selectedHost} onChange={event => setHost(event.target.value)}><option value="" disabled>{t("Select a Machine")}</option>{hosts.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
      <ProjectPermissions value={mode} modes={data?.permission_modes[provider] ?? AGENT_PERMISSION_MODES[provider]} onChange={next => { modeTouched.current = true; setMode(next); }} />
      {selectedHost && <AgentModelPicker projectId={project.id} machineId={selectedHost} provider={provider} accountScope={JSON.stringify(project.account_bindings?.[selectedHost] ?? {})} value={preset} onChange={selection => { presetTouched.current = true; setPreset(selection); }} disabled={busy} />}
      <label>{t("Context handoff target")}<select className="select" value={target} onChange={event => setTarget(Number(event.target.value))}>{![150000, 200000].includes(target) && <option value={target}>{target.toLocaleString()}</option>}<option value={150000}>150,000</option><option value={200000}>200,000</option></select></label>
      <p className="field-hint">{t("A planning target for smaller Ticket workers, not a measured hard token limit.")}</p>
      <ProjectChecks choices={choices} selected={selected} onChange={ids => {setChecksTouched(true);setSelected(ids);}} />{problem && <p role="status">{problem}</p>}
      <label>{t("PR repository (owner/repository)")}<input className="input" value={prRepository} onChange={event => { publicationTouched.current = true; setPrRepository(event.target.value); }} /></label>
      <label>{t("PR target branch")}<input className="input" value={prBranch} onChange={event => { publicationTouched.current = true; setPrBranch(event.target.value); }} /></label>
      <label>{t("Delivery milestone")}<select className="select" value={milestone} onChange={event => setMilestone(event.target.value as "merge" | "release")}><option value="merge">{t("Verified merge")}</option><option value="release">{t("Containing release")}</option></select></label>
      <p className="field-hint">{t("Publish a checked PR automatically after Specification approval.")}</p>
      <h3>{t("Matt Pocock workflow")}</h3><p>{t("Repository documents provide domain language and coding standards. Existing custom guidance is preserved.")}</p>{data && <ul>{data.guidance.map(file => <li key={file}>{file}</li>)}</ul>}
      <p className="field-hint">{t("Pinned skills, approved Tickets, checks and independent reviews remain required.")}</p>
      <button className="btn" disabled={busy || !selectedHost}>{t("Save Project settings")}</button>
    </form>}
    {section === "checkout" && <form className="factory-form" onSubmit={event => { event.preventDefault(); void perform(async () => { await factoryRequest(`/projects/${project.id}/checkouts`, { machine_id: machineId, path }); }); }}><ProjectFolderPicker key={machineId} machineId={machineId} value={path} onPick={setPath} disabled={busy || machines.find(m => m.id === machineId)?.state !== "connected"} /><button className="btn" disabled={busy || !path}>{t("Verify Machine checkout")}</button></form>}
  </section>;
}
