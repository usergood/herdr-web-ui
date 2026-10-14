import { useId, useState } from "react";
import { PROJECT_TRIAGE_ROLES, type IssueReadinessReason, type ProjectGitHubConfiguration, type ProjectGitHubOverview, type ProjectGitHubSource, type ProjectIssuePlan } from "../../shared/github-project.ts";
import { useT } from "../lib/i18n.ts";
import { accountRequest } from "../lib/accountsApi.ts";
import { SettingsGroup, SettingsRow, Toggle } from "./SettingsControls.tsx";
import "./ProjectIssueReadiness.css";

export function ProjectIssuePolicy({ form, change }: { form: ProjectGitHubConfiguration; change: (value: ProjectGitHubConfiguration) => void }) {
  const t = useT(), id = useId();
  const labels = [t("Triage label"), t("More information label"), t("Agent implementation label"), t("Human implementation label"), t("Will not fix label")];
  return <SettingsGroup title={t("Issue triage and readiness")} note={t("Unset labels inherit the defaults. Readiness applies only to an approved issue revision.")}>
    {PROJECT_TRIAGE_ROLES.map((role, index) => <SettingsRow key={role} label={labels[index]!} htmlFor={`${id}-${role}`} wide><input className="input project-issue-input" id={`${id}-${role}`} maxLength={50} placeholder={role} value={form.triage_labels?.[role] ?? ""} onChange={event => change({ ...form, triage_labels: { ...form.triage_labels, [role]: event.target.value } })} /></SettingsRow>)}
    <SettingsRow label={t("Implement trusted ready issues automatically")}><Toggle label={t("Implement trusted ready issues automatically")} checked={form.auto_implement ?? false} onChange={checked => change({ ...form, auto_implement: checked })} /></SettingsRow>
    <SettingsRow label={t("Trusted issue approvers")} description={t("GitHub logins, one per line. PR reviewers are configured separately.")} htmlFor={`${id}-trusted`} wide><textarea className="input project-issue-input" id={`${id}-trusted`} value={(form.trusted_issue_approvers ?? []).join("\n")} onChange={event => change({ ...form, trusted_issue_approvers: event.target.value.split("\n") })} /></SettingsRow>
  </SettingsGroup>;
}

export function ProjectIssueReadiness({ source, policyRevision, route, busy, perform, onChanged }: { source: ProjectGitHubSource; policyRevision: string; route: string; busy: boolean; perform: (action: () => Promise<void>) => Promise<void>; onChanged: (view: ProjectGitHubOverview) => void }) {
  const t = useT();
  const [plan, setPlan] = useState<ProjectIssuePlan>(source.readiness?.approval?.plan ?? { acceptance_criteria: "", dependencies: [], testing_seams: [], planning_decisions: [] });
  const [problem, setProblem] = useState("");
  const reasons: Record<IssueReadinessReason, string> = { start_planning: t("Start planning explicitly from Inbox."), human_only: t("This issue requires human implementation."), wontfix: t("This issue will not be actioned."), conflicting_triage: t("Correct conflicting triage labels."), approval_required: t("Approval of this issue revision is required."), automatic_implementation_disabled: t("Automatic implementation is disabled for this Project."), issue_closed: t("This issue is closed.") };
  return <section className="factory-section project-issue-readiness" role="region" aria-label={t("Issue #{number}", { number: source.number })}>
    <h4><a href={source.url} target="_blank" rel="noreferrer">#{source.number} · {source.issue?.title}</a></h4>
    <p>{source.triage_roles?.join(" · ")}</p>
    <div role="status">{source.readiness?.eligible ? <p>{t("Eligible for automatic implementation")}</p> : source.readiness?.reasons.map(reason => <p key={reason}>{reasons[reason]}</p>)}</div>
    <details><summary>{t("Issue scope")}</summary><pre className="project-issue-scope">{source.issue?.body}</pre></details>
    {source.readiness?.approval?.issue_revision === source.revision && !source.readiness.approval.revoked_at && source.readiness.approval.policy_revision === policyRevision && <p>{t("Approved by {actor}", { actor: source.readiness.approval.actor })}</p>}
    {source.state === "open" && source.triage_roles?.length === 1 && source.triage_roles[0] === "ready-for-agent" && <form className="factory-form" onSubmit={event => { event.preventDefault(); void perform(async () => { try { setProblem(""); onChanged(await accountRequest<ProjectGitHubOverview>(`${route}/issues/${source.number}/approve`, { issue_revision: source.revision, policy_revision: policyRevision, plan: { ...plan, testing_seams: plan.testing_seams.map(s => s.trim()).filter(Boolean), planning_decisions: plan.planning_decisions.map(s => s.trim()).filter(Boolean) } })); } catch (error) { setProblem((error as Error).message); } }); }}>
      <label>{t("Acceptance criteria")}<textarea className="input" required maxLength={50000} value={plan.acceptance_criteria} onChange={event => setPlan({ ...plan, acceptance_criteria: event.target.value })} /></label>
      <label>{t("Confirmed testing seams")}<textarea className="input" required value={plan.testing_seams.join("\n")} onChange={event => setPlan({ ...plan, testing_seams: event.target.value.split("\n") })} /></label>
      <label>{t("Planning decisions")}<textarea className="input" value={plan.planning_decisions.join("\n")} onChange={event => setPlan({ ...plan, planning_decisions: event.target.value.split("\n") })} /></label>
      {plan.dependencies.map((dependency, index) => <fieldset key={index} className="project-issue-dependency"><legend>{t("Dependency")}</legend>
        <label>{t("Repository (owner/name)")}<input className="input" required value={dependency.repository} onChange={event => setPlan({ ...plan, dependencies: plan.dependencies.map((value, i) => i === index ? { ...value, repository: event.target.value } : value) })} /></label>
        <label>{t("Issue number")}<input className="input" type="number" required min={1} value={dependency.issue_number} onChange={event => setPlan({ ...plan, dependencies: plan.dependencies.map((value, i) => i === index ? { ...value, issue_number: Number(event.target.value) } : value) })} /></label>
        <label>{t("Required delivery")}<select className="select" value={dependency.requires} onChange={event => setPlan({ ...plan, dependencies: plan.dependencies.map((value, i) => i === index ? { ...value, requires: event.target.value as "merge" | "release" } : value) })}><option value="merge">{t("Verified merge")}</option><option value="release">{t("Containing release")}</option></select></label>
        <button className="btn" type="button" onClick={() => setPlan({ ...plan, dependencies: plan.dependencies.filter((_, i) => i !== index) })}>{t("Remove dependency")}</button>
      </fieldset>)}
      <button className="btn" type="button" onClick={() => setPlan({ ...plan, dependencies: [...plan.dependencies, { repository: source.repository ?? "", issue_number: 1, requires: "merge" }] })}>{t("Add dependency")}</button>
      <button className="btn" disabled={busy}>{t("Approve this issue revision")}</button>
      {problem && <p role="alert">{problem}</p>}
    </form>}
  </section>;
}
