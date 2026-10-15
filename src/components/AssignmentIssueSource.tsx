import type { GitHubDependencyEdge, ProjectGitHubIssueRevision, ProjectGitHubSource } from "../../shared/github-project.ts";
import type { FactoryTicket } from "../../shared/factory.ts";
import { useT } from "../lib/i18n.ts";
import { IssueReadiness } from "./IssueReadiness.tsx";
import { accountRequest } from "../lib/accountsApi.ts";
import { Markdown } from "./Markdown.tsx";
import "./AssignmentIssueSource.css";
import { useState } from "react";

function IssueRevision({ revision }: { revision: ProjectGitHubIssueRevision }) {
  const t = useT();
  return <article className="assignment-issue-revision">
    <h4>{revision.title}</h4>
    <p>{revision.state === "open" ? t("Issue is open") : t("Issue is closed")}</p>
    {revision.labels.length > 0 && <p>{revision.labels.join(" · ")}</p>}
    <Markdown>{revision.body}</Markdown>
    <details><summary>{t("Source revision {revision}", { revision: revision.revision.slice(0, 12) })}</summary>
      <p>{revision.revision}</p>
      <p>{t("Source updated {time}", { time: new Date(revision.source_updated_at).toLocaleString() })}</p>
      <p>{t("Fetched {time}", { time: new Date(revision.fetched_at).toLocaleString() })}</p>
    </details>
  </article>;
}

function DependencyReason({ edge }: { edge: GitHubDependencyEdge }) {
  const t = useT();
  switch (edge.blocker) {
    case "delivery_unverified": return <p>{t("Delivery has not been verified.")}</p>;
    case "wrong_target": return <p>{t("Intended PRs must merge into the target branch.")}</p>;
    case "release_unverified": return <p>{t("A containing release has not been verified.")}</p>;
    case null: return <p>{t("Verified dependency delivery.")}</p>;
    case "cross_boundary": return <p>{t("Dependency crosses a Project or repository boundary. Resolve it before starting work.")}</p>;
    case "cyclic": return <p>{t("Dependency cycle. Correct the declared relationships.")}</p>;
    case "ambiguous": return <p>{t("Dependency identity is ambiguous. Inspect the declared relationships.")}</p>;
    case "missing": return <p>{t("Dependency is missing or inaccessible in this Project. Check access and sync GitHub.")}</p>;
  }
}

function NativeDependencies({ source }: { source: ProjectGitHubSource }) {
  const t = useT(); const evidence = source.dependencies;
  return <section aria-label={t("Issue dependencies")} className="assignment-native-dependencies">
    <h4>{t("Issue dependencies")}</h4>
    {!evidence ? <p role="status">{t("Sync GitHub to collect dependency evidence.")}</p> : <>
      {(!evidence.complete || !evidence.fresh) && <p role="status">{t("Dependency evidence is stale or incomplete. Sync GitHub before starting work.")}</p>}
      <p role="status">{evidence.satisfied ? t("Dependencies are satisfied.") : t("Dependencies are blocked.")}</p>
      {evidence.target_branch && <p>{t("Target branch")}: {evidence.target_branch}</p>}
      {!!evidence.conflicts?.length && <p role="alert">{t("Approved plan dependencies are unresolved. Declare a JSON array with repository, issue number and merge or release requirements, or None.")}</p>}
      <p>{t("These are explicit relationships. Closing an issue does not verify delivery.")}</p>
      {evidence.edges.length === 0 ? <p>{t("No issue dependencies.")}</p> : <ul>
        {evidence.edges.map(edge => <li key={`${edge.repository}:${edge.number}:${edge.external_id}`}>
          <a href={edge.url} target="_blank" rel="noreferrer">{edge.repository} #{edge.number}</a>
          {edge.blocker === null && !evidence.fresh ? <p>{t("Delivery evidence needs refresh.")}</p> : <DependencyReason edge={edge} />}
          <p>{edge.requires === "release" ? t("Requires merge and containing release") : t("Requires verified merge")}</p>
          {edge.provenance?.map((origin, index) => <p key={index}>{origin.kind === "github_native" ? t("Native GitHub relationship") : t("Approved app plan")}</p>)}
          {edge.delivery?.merges.map(merge => <p key={merge.number}><a href={merge.url} target="_blank" rel="noreferrer">{t("PR #{number}", { number: merge.number })}</a> · {merge.target_branch} · <code>{merge.merge_commit}</code></p>)}
          {edge.delivery?.release && <p><a href={edge.delivery.release.url} target="_blank" rel="noreferrer">{edge.delivery.release.tag}</a></p>}
          {edge.resolution === "resolved" && edge.implementation_id && <a href={`#factory/${edge.implementation_id}`}>{t("Open prerequisite Assignment")}</a>}
        </li>)}
      </ul>}
    </>}
  </section>;
}

function DependencyDelivery({ source, busy, perform }: { source: ProjectGitHubSource; busy: boolean; perform: (action: () => Promise<void>) => Promise<void> }) {
  const t = useT();
  const [branch, setBranch] = useState(source.delivery?.target_branch ?? source.dependencies?.target_branch ?? "");
  const [pulls, setPulls] = useState(source.delivery?.intended_prs.map(pull => `${pull.number} ${pull.head}`).join("\n") ?? "");
  const [release, setRelease] = useState(source.delivery?.release_tag ?? "");
  return <section className="assignment-dependency-delivery" aria-label={t("Dependency delivery")}>
    <h4>{t("Dependency delivery")}</h4>
    <p>{t("Link all intended PRs for this issue. Linking coverage does not verify delivery.")}</p>
    <form onSubmit={event => { event.preventDefault(); void perform(async () => {
      const intended = pulls.trim() ? pulls.trim().split(/\n/).map(line => {
        const match = /^\s*(\d+)\s+([a-f0-9]{40})\s*$/.exec(line);
        if (!match) throw new Error(t("Enter one PR number and exact head per line."));
        return { number: Number(match[1]), head: match[2]! };
      }) : [];
      await accountRequest(`/projects/${source.project_id}/github/issues/${source.number}/delivery`, { source_revision: source.revision, expected_revision: source.delivery?.revision ?? null, target_branch: branch.trim(), intended_prs: intended, release_tag: release.trim() || null });
    }); }}>
      <label className="field">{t("Target branch")}<input className="input" required value={branch} onChange={event => setBranch(event.target.value)} /></label>
      <label className="field">{t("Intended PRs")}<textarea className="input" rows={3} value={pulls} onChange={event => setPulls(event.target.value)} /></label>
      <p>{t("Enter one PR number and exact head per line.")}</p>
      <label className="field">{t("Release tag")}<input className="input" value={release} onChange={event => setRelease(event.target.value)} /></label>
      <button className="btn" disabled={busy}>{t("Save intended coverage")}</button>
    </form>
    {source.delivery && <p role="status">{source.delivery.source_revision === source.revision ? t("Coverage linked. Sync GitHub to verify delivery.") : t("Issue changed. Review and relink intended coverage.")}</p>}
  </section>;
}

export function AssignmentIssueSource({ sources, problem, busy, perform, tickets, questionRevision }: { sources: ProjectGitHubSource[]; problem: string | null; busy: boolean; perform: (action: () => Promise<void>) => Promise<void>; tickets: FactoryTicket[]; questionRevision: string }) {
  const t = useT(); const issues = sources.filter(source => source.kind === "issue");
  if (!issues.length) return null;
  return <section className="factory-section assignment-issue-source" aria-label={t("GitHub issue source")}>
    <h3>{t("GitHub issue source")}</h3>
    {problem && <p role="alert">{problem}</p>}
    {issues.map(source => <div key={source.id}>
      <a href={source.url} target="_blank" rel="noreferrer">{source.current?.repository ?? "GitHub"} #{source.number}</a>
      {source.current ? <IssueRevision revision={source.current} /> : <p role="status">{t("Sync GitHub to collect source history.")}</p>}
      <IssueReadiness readiness={source.readiness} />
      {source.readiness_evidence?.problem && <p role="alert">{source.readiness_evidence.problem}</p>}
      {source.readiness && !source.readiness.eligible && source.readiness.blockers.every(reason => ["evidence_missing", "untrusted", "stale"].includes(reason)) && <>
        <p>{t("Approval covers only the displayed source revision, including its plan, acceptance, dependencies and testing seams.")}</p>
        <button className="btn" disabled={busy} onClick={() => void perform(async () => { await accountRequest(`/projects/${source.project_id}/github/issues/${source.number}/approve`, { source_revision: source.revision, policy_revision: source.readiness_evidence!.policy_revision }); })}>{t("Approve this issue revision")}</button>
      </>}
      <NativeDependencies source={source} />
      <DependencyDelivery key={`${source.id}:${source.delivery?.revision ?? ""}:${source.revision}`} source={source} busy={busy} perform={perform} />
      {(source.readiness?.eligible || source.planning) && <section aria-label={t("Issue planning")} className="assignment-issue-planning">
        <h4>{t("Issue planning")}</h4>
        {source.planning && <>
          <p role="status">{source.planning.condition === "prepared" ? t("Planning prepared") : source.planning.condition === "needs_you" ? t("Needs you") : t("Planning changed. Review the current scope and readiness.")}</p>
          <p>{source.planning.origin === "app_plan" ? t("Reused approved app plan") : t("Reused trusted issue plan")}</p>
          <p>{t("Approved by {login}", { login: source.planning.authorization.approval.actor.login })} · {source.planning.authorization.approval.provenance === "app_owner" ? t("Owner approval in app") : t("Trusted GitHub label")}</p>
          <p>{t("Required checks and independent Standards and Spec reviews still apply.")}</p>
          <details><summary>{t("Reused planning")}</summary><Markdown>{source.planning.content}</Markdown>
            <p>{source.planning.source_revision}</p><p>{source.planning.graph_hash}</p>
            <p>{t("Declared dependencies")}</p><Markdown>{source.planning.dependencies}</Markdown>
            <p>{t("Testing seams")}</p><Markdown>{source.planning.testing_seams}</Markdown>
          </details>
          {source.planning.condition === "prepared" && <div><h4>{t("Tickets")}</h4>{tickets.filter(ticket => ticket.specification_id === source.planning!.specification_id).map(ticket => <article key={ticket.id}>
            <strong>{ticket.title}</strong><Markdown>{ticket.acceptance}</Markdown>
            {!!ticket.dependencies.length && <p>{t("Blocked by: {tickets}", { tickets: ticket.dependencies.map(id => tickets.find(ticket => ticket.id === id)?.title ?? id).join(", ") })}</p>}
          </article>)}</div>}
        </>}
        {source.readiness?.eligible && source.planning?.condition !== "prepared" && <button className="btn" disabled={busy} onClick={() => void perform(async () => { await accountRequest(`/projects/${source.project_id}/github/issues/${source.number}/prepare`, { source_revision: source.revision, question_revision: questionRevision }); })}>{t("Prepare issue plan")}</button>}
      </section>}
      {!!source.history?.length && <details><summary>{t("Source history")}</summary>
        {source.history.map((revision, index) => <IssueRevision key={`${revision.revision}:${index}`} revision={revision} />)}
      </details>}
    </div>)}
  </section>;
}
