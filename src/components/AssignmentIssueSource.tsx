import type { GitHubDependencyEdge, ProjectGitHubIssueRevision, ProjectGitHubSource } from "../../shared/github-project.ts";
import type { FactoryTicket } from "../../shared/factory.ts";
import { useT } from "../lib/i18n.ts";
import { IssueReadiness } from "./IssueReadiness.tsx";
import { accountRequest } from "../lib/accountsApi.ts";
import { Markdown } from "./Markdown.tsx";
import "./AssignmentIssueSource.css";

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
    case "cross_boundary": return <p>{t("Dependency crosses a Project or repository boundary. Resolve it before starting work.")}</p>;
    case "cyclic": return <p>{t("Dependency cycle. Correct the native relationships on GitHub.")}</p>;
    case "ambiguous": return <p>{t("Dependency identity is ambiguous. Inspect the native relationship on GitHub.")}</p>;
    case "missing": return <p>{t("Dependency is missing or inaccessible in this Project. Check access and sync GitHub.")}</p>;
  }
}

function NativeDependencies({ source }: { source: ProjectGitHubSource }) {
  const t = useT(); const evidence = source.dependencies;
  return <section aria-label={t("Native GitHub dependencies")} className="assignment-native-dependencies">
    <h4>{t("Native GitHub dependencies")}</h4>
    {!evidence ? <p role="status">{t("Sync GitHub to collect native dependency evidence.")}</p> : <>
      {(!evidence.complete || !evidence.fresh) && <p role="status">{t("Dependency evidence is stale or incomplete. Sync GitHub before starting work.")}</p>}
      <p>{t("These are explicit relationships. Closing an issue does not verify delivery.")}</p>
      {evidence.edges.length === 0 ? <p>{t("No native GitHub dependencies.")}</p> : <ul>
        {evidence.edges.map(edge => <li key={`${edge.repository}:${edge.external_id}`}>
          <a href={edge.url} target="_blank" rel="noreferrer">{edge.repository} #{edge.number}</a>
          <DependencyReason edge={edge} />
          {edge.resolution === "resolved" && edge.implementation_id && <a href={`#factory/${edge.implementation_id}`}>{t("Open prerequisite Assignment")}</a>}
        </li>)}
      </ul>}
    </>}
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
