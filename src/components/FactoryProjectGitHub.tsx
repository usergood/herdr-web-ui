import { useEffect, useState } from "react";
import type { FactoryProject, ProjectGitHubConfiguration, ProjectGitHubFiles, ProjectGitHubOverview } from "../../shared/protocol.ts";
import type { AccountOverview } from "../../shared/accounts.ts";
import { useT } from "../lib/i18n.ts";
import { ApiError } from "../lib/api.ts";
import { factoryRequest } from "../lib/factoryApi.ts";
import "./FactoryProjectGitHub.css";

export function FactoryProjectGitHub({ project, busy, perform }: { project: FactoryProject; busy: boolean; perform: (action: () => Promise<void>) => Promise<void> }) {
  const t = useT(); const route = `/projects/${project.id}/github`;
  const [view, setView] = useState<ProjectGitHubOverview | null>(null);
  const [accounts, setAccounts] = useState<AccountOverview | null>(null);
  const [problem, setProblem] = useState("");
  const [diffs, setDiffs] = useState<Record<number, ProjectGitHubFiles>>({});
  const [form, setForm] = useState<ProjectGitHubConfiguration>({ expected_revision: null, repository: "", account_profile_id: "", sync_enabled: false, import_issues: false, import_fixes: false, auto_update: false, auto_merge: false, trusted_reviewers: [], required_checks: [], review_context: "", poll_minutes: 5 });
  async function refresh() { const next = await factoryRequest<ProjectGitHubOverview>(route); setView(next); return next; }
  useEffect(() => {
    let active = true;
    void Promise.all([factoryRequest<ProjectGitHubOverview>(route), factoryRequest<AccountOverview>("/machines/local/accounts")]).then(([next, profiles]) => {
      if (!active) return; setView(next); setAccounts(profiles);
      if (next.policy) { const policy = next.policy; setForm({ repository: policy.repository, account_profile_id: policy.account_profile_id, sync_enabled: policy.sync_enabled, import_issues: policy.import_issues, import_fixes: policy.import_fixes, auto_update: policy.auto_update, auto_merge: policy.auto_merge, trusted_reviewers: policy.trusted_reviewers, required_checks: policy.required_checks, review_context: policy.review_context, poll_minutes: policy.poll_minutes, expected_revision: policy.revision }); }
    }).catch((error) => { if (active) setProblem(error.message); });
    return () => { active = false; };
  }, [route]);
  async function post(path: string, body: unknown) {
    const url = `/api/factory${route}${path}`;
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-herdr-factory": "1", "x-herdr-machine": "1" }, body: JSON.stringify(body) });
    const data = await response.json(); if (!response.ok) throw new ApiError(url, response.status, data.error?.message ?? response.statusText, data.error?.code ?? null); return data;
  }
  return <details className="factory-section" data-testid="project-github" onToggle={(event) => { if (event.currentTarget.open) void factoryRequest<AccountOverview>("/machines/local/accounts").then(setAccounts).catch((error) => setProblem(error.message)); }}><summary>{t("Project GitHub workflow")}</summary>
    {problem && <p role="alert">{problem}</p>}
    <form className="factory-form" onSubmit={(event) => { event.preventDefault(); void perform(async () => { const policy = await post("/configure", { ...form, trusted_reviewers: form.trusted_reviewers.map((value) => value.trim()).filter(Boolean), required_checks: form.required_checks.map((value) => value.trim()).filter(Boolean) }); setForm({ ...form, expected_revision: policy.revision }); await refresh(); }); }}>
      <label>{t("Repository (owner/name)")}<input className="input factory-input" required value={form.repository} onChange={(event) => setForm({ ...form, repository: event.target.value })} /></label>
      <label>{t("GitHub account")}<select className="select factory-input" required value={form.account_profile_id} onChange={(event) => setForm({ ...form, account_profile_id: event.target.value })}><option value="">{t("Select account")}</option>{accounts?.profiles.filter((profile) => profile.service === "github" && profile.state === "ready").map((profile) => <option key={profile.id} value={profile.id}>{profile.name} · {profile.expected_login}</option>)}</select></label>
      <label>{t("Review rules")}<textarea className="input factory-input" value={form.review_context} onChange={(event) => setForm({ ...form, review_context: event.target.value })} /></label>
      <label>{t("Trusted reviewers")}<textarea className="input factory-input" value={form.trusted_reviewers.join("\n")} onChange={(event) => setForm({ ...form, trusted_reviewers: event.target.value.split("\n") })} /></label>
      <label>{t("Required GitHub checks")}<textarea className="input factory-input" value={form.required_checks.join("\n")} onChange={(event) => setForm({ ...form, required_checks: event.target.value.split("\n") })} /></label>
      <label>{t("Automatic sync")}<input type="checkbox" checked={form.sync_enabled} onChange={(event) => setForm({ ...form, sync_enabled: event.target.checked })} /></label>
      <label>{t("Import GitHub issues")}<input type="checkbox" checked={form.import_issues} onChange={(event) => setForm({ ...form, import_issues: event.target.checked })} /></label>
      <label>{t("Import requested changes")}<input type="checkbox" checked={form.import_fixes} onChange={(event) => setForm({ ...form, import_fixes: event.target.checked })} /></label>
      <label>{t("Update behind branches")}<input type="checkbox" checked={form.auto_update} onChange={(event) => setForm({ ...form, auto_update: event.target.checked })} /></label>
      <label>{t("Merge approved PRs")}<input type="checkbox" checked={form.auto_merge} onChange={(event) => setForm({ ...form, auto_merge: event.target.checked })} /></label>
      <label>{t("Polling interval (minutes)")}<input className="input factory-input" type="number" min="5" max="1440" value={form.poll_minutes} onChange={(event) => setForm({ ...form, poll_minutes: Number(event.target.value) })} /></label>
      <button className="btn factory-button" disabled={busy}>{t("Save Project settings")}</button>
    </form>
    <button className="btn factory-button" disabled={busy || !view?.policy} onClick={() => void perform(async () => { setView(await post("/sync", {})); })}>{t("Sync GitHub")}</button>
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
      <div className="factory-actions">{(["import", "update", "rerequest", "merge"] as const).map((action) => <button key={action} className="btn factory-button" disabled={busy || action === "merge" && !!item.blockers.length || action === "update" && item.pull.mergeStateStatus !== "BEHIND"} onClick={() => void perform(async () => { await post(`/pulls/${item.pull.number}/${action}`, { head: item.pull.headRefOid, base: item.pull.baseRefOid, policy_revision: view.policy!.revision }); await refresh(); })}>{action === "import" ? t("Import PR review") : action === "update" ? t("Update branch") : action === "rerequest" ? t("Request review again") : t("Merge PR")}</button>)}</div>
    </article>)}
    {view?.mutations.map((mutation) => <p role="status" key={mutation.id}>#{mutation.number} · {mutation.action} · {mutation.condition}{mutation.problem ? `: ${mutation.problem}` : ""}</p>)}
  </details>;
}
