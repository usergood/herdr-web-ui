import { useEffect, useRef, useState } from "react";
import type { FactoryProject, ProjectGitHubConfiguration, ProjectGitHubFiles, ProjectGitHubOverview } from "../../shared/protocol.ts";
import type { ProjectGitHubSettings } from "../../shared/github-project.ts";
import type { ProjectDiscovery } from "../../shared/project-setup.ts";
import type { AccountOverview } from "../../shared/accounts.ts";
import { useT } from "../lib/i18n.ts";
import { accountRequest } from "../lib/accountsApi.ts";
import { factoryRequest } from "../lib/factoryApi.ts";
import { NativeAccountImport } from "./NativeAccountImport.tsx";
import "./FactoryProjectGitHub.css";

export function FactoryProjectGitHub({ project, busy, perform, checkoutPath, checkout, machineName }: { project: FactoryProject; busy: boolean; perform: (action: () => Promise<void>) => Promise<void>; checkoutPath?: string; checkout?: { machine_id: string; path: string }; machineName?: string }) {
  const t = useT(); const route = `/projects/${project.id}/github`;
  const [view, setView] = useState<ProjectGitHubOverview | null>(null);
  const [accounts, setAccounts] = useState<AccountOverview | null>(null);
  const [defaults, setDefaults] = useState<ProjectGitHubSettings | null>(null);
  const [problem, setProblem] = useState("");
  const [notice, setNotice] = useState("");
  const [diffs, setDiffs] = useState<Record<number, ProjectGitHubFiles>>({});
  const epoch = useRef(0);
  const [form, setForm] = useState<ProjectGitHubConfiguration>({ expected_revision: null, repository: "", account_profile_id: "", sync_enabled: false, import_issues: false, import_fixes: false, auto_update: false, auto_merge: false, trusted_reviewers: [], required_checks: [], review_context: "Review against the repository's coding standards, domain language and accepted scope.", poll_minutes: 5 });
  async function refresh() { const id = epoch.current; const next = await factoryRequest<ProjectGitHubOverview>(route); if (id === epoch.current) setView(next); return next; }
  async function reloadAccounts() { const id = epoch.current; const next = await accountRequest<AccountOverview>("/machines/local/accounts"); if (id === epoch.current) setAccounts(next); return next; }
  useEffect(() => {
    const id = ++epoch.current;
    setDefaults(null); setProblem(""); setNotice("");
    const metadata = checkout ? factoryRequest<ProjectDiscovery>("/project-discovery", { machine_id: checkout.machine_id, path: checkout.path }).catch(error => { if (id === epoch.current) setNotice(error.message); return null; }) : Promise.resolve(null);
    void Promise.all([factoryRequest<ProjectGitHubOverview>(route), accountRequest<AccountOverview>("/machines/local/accounts")]).then(async ([next, profiles]) => {
      if (id !== epoch.current) return;
      setView(next); setAccounts(profiles);
      if (next.policy) { const policy = next.policy; setForm({ repository: policy.repository, account_profile_id: policy.account_profile_id, sync_enabled: policy.sync_enabled, import_issues: policy.import_issues, import_fixes: policy.import_fixes, auto_update: policy.auto_update, auto_merge: policy.auto_merge, trusted_reviewers: policy.trusted_reviewers, required_checks: policy.required_checks, review_context: policy.review_context, poll_minutes: policy.poll_minutes, expected_revision: policy.revision }); }
      else {
        const repository = await metadata;
        if (id !== epoch.current) return;
        const ready = profiles.profiles.filter(p => p.service === "github" && p.state === "ready");
        const chosen = project.account_bindings?.local?.github ?? ready.find(p => p.expected_login.toLowerCase() === repository?.github.account_hint?.toLowerCase())?.id ?? (ready.length === 1 ? ready[0]!.id : "");
        setForm(current => ({ ...current, repository: repository?.github.repository ?? "", account_profile_id: current.account_profile_id || chosen }));
      }
    }).catch(error => { if (id === epoch.current) setProblem(error.message); });
    return () => { epoch.current++; };
  }, [route, checkout?.machine_id, checkout?.path]);
  useEffect(() => {
    if (!form.account_profile_id || accounts?.profiles.find(p => p.id === form.account_profile_id)?.state !== "ready") return;
    let live = true;
    void accountRequest<ProjectGitHubSettings>(route + "/settings", { account_profile_id: form.account_profile_id }).then(value => { if (live) { setDefaults(value); setForm(current => ({ ...current, repository: value.repository, required_checks: current.required_checks.length ? current.required_checks : value.required_checks })); } }, error => { if (live) setProblem(error.message); });
    return () => { live = false; };
  }, [route, form.account_profile_id, accounts?.profiles]);
  const ready = accounts?.profiles.find(p => p.id === form.account_profile_id)?.state === "ready";
  return <section className="factory-section" data-testid="project-github"><h3>{t("Project GitHub workflow")}</h3>
    <p className="field-hint">{t("GitHub uses a verified account on the connection server: {name}", { name: machineName ?? t("Machine") })}</p>
    {notice && <p role="status">{notice}</p>}
    {problem && <p role="alert">{problem}</p>}
    <form className="factory-form" onSubmit={event => { event.preventDefault(); void perform(async () => {
      const id = epoch.current;
      if (checkoutPath) await accountRequest(`/projects/${project.id}/configure`, { account_bindings: { ...project.account_bindings, local: { ...project.account_bindings?.local, github: form.account_profile_id } } });
      const policy = await accountRequest<{ revision: string }>(route + "/configure", form); if (id !== epoch.current) return; setForm(current => ({ ...current, expected_revision: policy.revision })); await refresh();
    }); }}>
      <label>{t("Repository (owner/name)")}<input className="input" readOnly value={form.repository} /></label>
      {!form.repository && <p role="status">{t("No GitHub remote detected for this checkout.")}</p>}
      <label>{t("GitHub account")}<select className="select" value={form.account_profile_id} onChange={event => { setProblem(""); setDefaults(null); setForm(current => ({ ...current, account_profile_id: event.target.value })); }}><option value="">{t("Select account")}</option>{accounts?.profiles.filter(p => p.service === "github" && p.state !== "disabled").map(p => <option key={p.id} value={p.id} disabled={p.state !== "ready"}>{p.name} · {p.expected_login} · {p.state === "ready" ? t("Ready") : t("Needs sign-in")}</option>)}</select></label>
      {!ready && <p className="field-hint">{t("Import a saved login below or finish sign-in in Accounts. Created accounts remain visible until ready.")}</p>}
      <label><input type="checkbox" checked={form.sync_enabled} onChange={event => setForm({ ...form, sync_enabled: event.target.checked })} />{t("Automatic sync")}</label>
      <label><input type="checkbox" checked={form.import_issues} onChange={event => setForm({ ...form, import_issues: event.target.checked })} />{t("Import GitHub issues")}</label>
      <details><summary>{t("Advanced GitHub automation")}</summary>
        <p>{t("Repository standards provide review guidance. Automation stays off until you choose its rules.")}</p>
        <label><input type="checkbox" checked={form.import_fixes} onChange={event => setForm({ ...form, import_fixes: event.target.checked })} />{t("Import requested changes")}</label>
        <label><input type="checkbox" checked={form.auto_update} onChange={event => setForm({ ...form, auto_update: event.target.checked })} />{t("Update behind branches")}</label>
        <label><input type="checkbox" checked={form.auto_merge} disabled={!defaults?.protected && !view?.policy?.auto_merge} onChange={event => setForm({ ...form, auto_merge: event.target.checked })} />{t("Merge approved PRs")}</label>
        <h4>{t("Trusted reviewers")}</h4>{[...new Set([...form.trusted_reviewers, ...defaults?.reviewers ?? []])].map(login => <label key={login}><input type="checkbox" checked={form.trusted_reviewers.includes(login)} onChange={event => setForm({ ...form, trusted_reviewers: event.target.checked ? [...form.trusted_reviewers, login] : form.trusted_reviewers.filter(x => x !== login) })} />{login}</label>)}
        <h4>{t("Required GitHub checks")}</h4>{[...new Set([...form.required_checks, ...defaults?.required_checks ?? []])].map(name => <label key={name}><input type="checkbox" checked={form.required_checks.includes(name)} onChange={event => setForm({ ...form, required_checks: event.target.checked ? [...form.required_checks, name] : form.required_checks.filter(x => x !== name) })} />{name}</label>)}
        <label>{t("Polling interval (minutes)")}<select className="select" value={form.poll_minutes} onChange={event => setForm({ ...form, poll_minutes: Number(event.target.value) })}>{[...new Set([5, 15, 30, 60, form.poll_minutes])].sort((a,b)=>a-b).map(n=><option key={n} value={n}>{n}</option>)}</select></label>
      </details>
      <button className="btn" disabled={busy || !ready || !form.repository}>{t("Save Project settings")}</button>
    </form>
    <NativeAccountImport machineId="local" path={checkoutPath} busy={busy} perform={perform} onImported={profile => { const id = epoch.current; setForm(current => ({ ...current, account_profile_id: profile.id })); void reloadAccounts().catch(error => { if (id === epoch.current) setProblem(error.message); }); }} />
    <button type="button" className="btn" disabled={busy || !view?.policy} onClick={() => void perform(async () => { setView(await accountRequest<ProjectGitHubOverview>(route + "/sync", {})); })}>{t("Sync GitHub")}</button>
    {view?.problem && <p role="alert">{view.problem}</p>}
    {view?.last_sync && <p>{new Date(view.last_sync).toLocaleString()}</p>}
    {view?.pulls.map((item) => <article className="factory-section" key={item.id}>
      <a href={item.pull.url} target="_blank" rel="noreferrer">#{item.pull.number} · {item.pull.title}</a>
      <p>{item.pull.author?.login} · {item.pull.headRefName} → {item.pull.baseRefName}</p>
      <button className="btn factory-button" disabled={busy} onClick={() => void perform(async () => { const diff = await factoryRequest<ProjectGitHubFiles>(`${route}/pulls/${item.pull.number}/files?head=${item.pull.headRefOid}`); setDiffs((previous) => ({ ...previous, [item.pull.number]: diff })); })}>{t("Source")}</button>
      {diffs[item.pull.number]?.head === item.pull.headRefOid && diffs[item.pull.number]?.files.map((file) => <details key={file.filename}><summary>{file.filename} · +{file.additions} −{file.deletions}</summary><pre className="factory-github-patch">{file.patch ?? file.status}</pre></details>)}
      <ul>{item.blockers.map((reason) => <li key={reason}>{reason}</li>)}</ul>
      {item.pull.reviews.nodes.map((review) => <p key={review.id}>{review.author?.login} · {review.state}: {review.body}</p>)}
      {item.pull.reviewThreads.nodes.filter((thread) => !thread.isResolved).map((thread) => <div key={thread.id}>{thread.comments.nodes.map((comment, index) => <p key={index}>{comment.path}: {comment.body}</p>)}</div>)}
      <div className="factory-actions">{(["import", "update", "rerequest", "merge"] as const).map((action) => <button key={action} className="btn factory-button" disabled={busy || action === "merge" && !!item.blockers.length || action === "update" && item.pull.mergeStateStatus !== "BEHIND"} onClick={() => void perform(async () => { await accountRequest(route + `/pulls/${item.pull.number}/${action}`, { head: item.pull.headRefOid, base: item.pull.baseRefOid, policy_revision: view.policy!.revision }); await refresh(); })}>{action === "import" ? t("Import PR review") : action === "update" ? t("Update branch") : action === "rerequest" ? t("Request review again") : t("Merge PR")}</button>)}</div>
    </article>)}
    {view?.mutations.map((mutation) => <p role="status" key={mutation.id}>#{mutation.number} · {mutation.action} · {mutation.condition}{mutation.problem ? `: ${mutation.problem}` : ""}</p>)}
  </section>;
}
