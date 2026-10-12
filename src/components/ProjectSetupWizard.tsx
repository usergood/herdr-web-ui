import { useEffect, useRef, useState } from "react";
import type { FactoryProject, FactoryProvider } from "../../shared/factory.ts";
import type { Machine } from "../../shared/machines.ts";
import type { AccountOverview } from "../../shared/accounts.ts";
import type { ProjectDiscovery } from "../../shared/project-setup.ts";
import type { AgentPermissionMode } from "../../shared/agent-permissions.ts";
import { factoryRequest } from "../lib/factoryApi.ts";
import { accountRequest } from "../lib/accountsApi.ts";
import { useT } from "../lib/i18n.ts";
import { ProjectFolderPicker } from "./ProjectFolderPicker.tsx";
import { ProjectPermissions } from "./ProjectPermissions.tsx";
import { NativeAccountImport } from "./NativeAccountImport.tsx";

export function ProjectSetupWizard({ machines, busy, perform, onProject }: { machines: Machine[]; busy: boolean; perform: (action: () => Promise<void>) => Promise<void>; onProject: (id: string) => void }) {
  const t=useT();const [host,setHost]=useState(machines[0]?.id??"");const machine=machines.find(m=>m.id===host);
  const [step,setStep]=useState(0);const [path,setPath]=useState("");const [name,setName]=useState("");const [data,setData]=useState<ProjectDiscovery|null>(null);const [loading,setLoading]=useState(false);const [problem,setProblem]=useState<string|null>(null);
  const [provider,setProvider]=useState<FactoryProvider>("codex");const [mode,setMode]=useState<AgentPermissionMode>("ask");const [checks,setChecks]=useState<string[]>([]);const [context,setContext]=useState(150000);const [guide,setGuide]=useState(false);const [github,setGithub]=useState("");const [accounts,setAccounts]=useState<AccountOverview|null>(null);const epoch=useRef(0);
  useEffect(()=>{if(!host&&machines[0])setHost(machines[0].id);},[host,machines]);
  useEffect(()=>{if(host&&!machine){epoch.current++;setData(null);setPath("");setStep(0);}},[host,machine]);
  useEffect(()=>()=>{epoch.current++;},[]);
  async function pick(next:string){const id=++epoch.current;setLoading(true);setProblem(null);setPath(next);setData(null);setGithub("");try{const result=await factoryRequest<ProjectDiscovery>("/project-discovery",{path:next,machine_id:host});if(id!==epoch.current)return;setData(result);setPath(result.path);setName(current=>current||result.name);setChecks(result.checks.map(c=>c.id));setMode(result.permission_modes.codex.includes("approve_for_me")?"approve_for_me":"ask");setGuide(!result.guidance.includes("AGENTS.md")&&!result.guidance.includes("CLAUDE.md"));setAccounts(await accountRequest<AccountOverview>(`/machines/${encodeURIComponent(host)}/accounts`));}catch(error){if(id===epoch.current)setProblem(error instanceof Error?error.message:String(error));}finally{if(id===epoch.current)setLoading(false);}}
  const names=[t("Repository"),t("Agent and checks"),t("Accounts"),t("Repository guidance")];
  return <section className="factory-section"><h2>{t("Set up a Project")}</h2><p role="status">{t("Step {current} of {total}: {name}",{current:step+1,total:names.length,name:names[step]??""})}</p>
    {problem&&<p role="alert">{problem}</p>}
    <form className="factory-form" onSubmit={event=>{event.preventDefault();if(step<3){setStep(step+1);return;}if(!data||!machine||machine.state!=="connected")return;const id=epoch.current;void perform(async()=>{const project=await accountRequest<FactoryProject>("/projects",{name,path,machine_id:host,provider,tracker:"app",guided_setup:true,permission_mode:mode,check_ids:checks,context_target_tokens:context,guidance_task:guide,...(github?{github_account_id:github}:{})});if(id===epoch.current)onProject(project.id);});}}>
      {step===0&&<><label>{t("Machine")}<select className="select" value={machine?.id??""} onChange={event=>{epoch.current++;setHost(event.target.value);setPath("");setData(null);setStep(0);setProblem(null);}}><option value="" disabled>{t("Select a Machine")}</option>{machines.map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
        <ProjectFolderPicker key={host} machineId={host} value={path} disabled={busy||!machine||machine.state!=="connected"} onPick={next=>void pick(next)}/>
        {loading&&<p role="status">{t("Detecting repository settings…")}</p>}
        <label>{t("Project name")}<input className="input" required maxLength={200} value={name} onChange={event=>setName(event.target.value)}/></label>{data&&<p>{data.github.repository??data.name}</p>}</>}
      {step===1&&data&&<><label>{t("CLI agent")}<select className="select" value={provider} onChange={event=>{const selected=event.target.value as FactoryProvider;setProvider(selected);setMode(selected==="codex"&&data.permission_modes.codex.includes("approve_for_me")?"approve_for_me":"ask");}}>{data.providers.map(p=><option key={p.provider} value={p.provider}>{p.provider}{!p.installed?` · ${t("Not installed")}`:""}</option>)}</select></label>
        <ProjectPermissions value={mode} modes={data.permission_modes[provider]} onChange={setMode}/><h3>{t("Repository checks")}</h3>{data.checks.map(check=><label key={check.id}><input type="checkbox" aria-label={check.name} checked={checks.includes(check.id)} onChange={event=>setChecks(current=>event.target.checked?[...current,check.id]:current.filter(id=>id!==check.id))}/>{check.name}<code>{check.args.join(" ")}</code></label>)}{!data.checks.length&&<p role="status">{t("No checks detected. You can save setup; add checks before implementation.")}</p>}
        <label>{t("Context handoff target")}<select className="select" value={context} onChange={event=>setContext(Number(event.target.value))}><option value={150000}>150,000</option><option value={200000}>200,000</option></select></label></>}
      {step===2&&<><label>{t("GitHub account")}<select className="select" value={github} onChange={event=>setGithub(event.target.value)}><option value="">{t("Current Machine account")}</option>{accounts?.profiles.filter(p=>p.service==="github"&&p.state!=="disabled").map(p=><option key={p.id} value={p.id} disabled={p.state!=="ready"}>{p.name} · {p.state==="ready"?t("Ready"):t("Needs sign-in")}</option>)}</select></label>
        <NativeAccountImport machineId={host} path={path} busy={busy} perform={perform} onImported={profile=>{setGithub(profile.id);void accountRequest<AccountOverview>(`/machines/${encodeURIComponent(host)}/accounts`).then(setAccounts);}}/>
        <p className="field-hint">{t("You can connect other accounts later in Project settings.")}</p></>}
      {step===3&&data&&<><h3>{t("Matt Pocock workflow")}</h3><p>{t("Reuse repository guidance and establish domain language and coding standards through a guided setup Assignment.")}</p><ul>{data.guidance.map(file=><li key={file}>{file}</li>)}</ul><label><input type="checkbox" checked={guide} onChange={event=>setGuide(event.target.checked)}/>{t("Create a guided repository setup Assignment")}</label><p className="field-hint">{t("The Assignment uses pinned skills, asks about missing decisions, and proposes changes for review.")}</p></>}
      <div className="factory-actions">{step>0&&<button type="button" className="btn" disabled={busy} onClick={()=>setStep(step-1)}>{t("Back")}</button>}<button className="btn btn-primary" disabled={busy||loading||!data||!machine||machine.state!=="connected"}>{step===3?t("Create Project"):t("Next")}</button></div>
    </form>
  </section>;
}
