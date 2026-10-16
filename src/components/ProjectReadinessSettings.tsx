import { useState } from "react";
import type { AccountOverview } from "../../shared/accounts.ts";
import { TRIAGE_ROLES, type ReadinessConfiguration, type ProjectReadinessPolicy } from "../../shared/github-readiness.ts";
import { useT } from "../lib/i18n.ts";
import { accountRequest } from "../lib/accountsApi.ts";

export function ProjectReadinessSettings({ projectId, policy, accounts, busy, perform, refresh }: { projectId: string; policy: ProjectReadinessPolicy | null; accounts: AccountOverview | null; busy: boolean; perform: (action: () => Promise<void>) => Promise<void>; refresh: () => Promise<unknown> }) {
  const t = useT();
  const [form, setForm] = useState<ReadinessConfiguration>({ expected_revision: policy?.revision ?? null, account_profile_id: policy?.account_profile_id ?? "", triage_labels: policy?.triage_labels ?? {}, blocked_label: policy?.blocked_label ?? "blocked" });
  return <section className="factory-section" aria-label={t("Issue readiness")}>
    <h4>{t("Issue readiness")}</h4>
    <p>{t("Readiness trust is separate from PR reviewers.")}</p>
    <form className="factory-form" onSubmit={event => { event.preventDefault(); void perform(async () => { await accountRequest(`/projects/${projectId}/github/readiness`, form); await refresh(); }); }}>
      <label>{t("Readiness account")}<select className="select" aria-label={t("Readiness account")} value={form.account_profile_id} required onChange={event => setForm({ ...form, account_profile_id: event.target.value })}>
        <option value="">{t("Select account")}</option>
        {accounts?.profiles.filter(profile => profile.service === "github" && profile.state !== "disabled").map(profile => <option key={profile.id} value={profile.id} disabled={profile.state !== "ready"}>{profile.name} · {profile.expected_login}</option>)}
      </select></label>
      <p>{t("Only the account you select can authorize issue readiness.")}</p>
      <details><summary>{t("Triage label mapping")}</summary>
        {TRIAGE_ROLES.map(role => <label key={role}>{role}<input className="input" maxLength={100} required value={form.triage_labels[role] ?? role} onChange={event => setForm({ ...form, triage_labels: { ...form.triage_labels, [role]: event.target.value } })} /></label>)}
        <label>{t("Blocked label")}<input className="input" maxLength={100} required value={form.blocked_label} onChange={event => setForm({ ...form, blocked_label: event.target.value })} /></label>
      </details>
      <button className="btn" disabled={busy || !form.account_profile_id}>{t("Save readiness settings")}</button>
    </form>
    {policy && <p>{t("Readiness identity: {login}", { login: policy.owner.login })}</p>}
  </section>;
}
