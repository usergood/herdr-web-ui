import { useEffect, useState } from "react";
import type { IssueBatch, IssueBatchesOverview } from "../../shared/issue-batches.ts";
import type { ProjectGitHubOverview } from "../../shared/github-project.ts";
import { accountRequest } from "../lib/accountsApi.ts";
import { useT } from "../lib/i18n.ts";
import { Markdown } from "./Markdown.tsx";
import "./FactoryIssueBatches.css";

export function FactoryIssueBatches({ implementationId, projectId, busy, perform }: { implementationId: string; projectId: string; busy: boolean; perform: (action: () => Promise<void>) => Promise<void> }) {
  const t = useT();
  const [batches, setBatches] = useState<IssueBatch[]>([]);
  const [policyRevision, setPolicyRevision] = useState<string | null>(null);
  const [problem, setProblem] = useState("");
  const route = `/implementations/${implementationId}/issue-batches`;
  useEffect(() => {
    let live = true, generation = 0;
    const read = async () => {
      const current = ++generation;
      try {
        const [plans, github] = await Promise.all([accountRequest<IssueBatchesOverview>(route), accountRequest<ProjectGitHubOverview>(`/projects/${projectId}/github`)]);
        if (live && current === generation) { setBatches(plans.batches); setPolicyRevision(github.policy?.revision ?? null); setProblem(""); }
      } catch (error) { if (live && current === generation) setProblem((error as Error).message); }
    };
    const changed = () => { void read(); };
    void read(); window.addEventListener("factory-changed", changed);
    return () => { live = false; generation++; window.removeEventListener("factory-changed", changed); };
  }, [route, projectId]);
  const act = (batch: IssueBatch, action: "review" | "publish" | "resume") => void perform(async () => {
    const next = await accountRequest<IssueBatch>(`${route}/${batch.id}/${action}`, { revision: batch.revision, policy_revision: policyRevision });
    setBatches(current => current.map(item => item.id === next.id ? next : item));
  });
  function condition(batch: IssueBatch): string {
    switch (batch.condition) { case "proposed": return t("Proposed"); case "reviewed": return t("Reviewed"); case "publishing": return t("Publishing"); case "held": return t("Publication held"); case "confirmed": return t("Published"); }
  }
  if (!batches.length && !problem) return null;
  return <section className="factory-section factory-issue-batches">
    <h3>{t("Planned issue batches")}</h3><p>{t("Review the whole batch before publishing issues.")}</p>
    {problem && <p role="alert">{problem}</p>}
    {batches.map(batch => <section key={batch.id} className="factory-issue-batch" role="region" aria-label={batch.title}>
      <h3>{batch.title}</h3><p role="status">{condition(batch)}</p>
      {batch.intents.length > 0 && <div role="status"><p>{t("Issues confirmed: {confirmed}/{total}", { confirmed: batch.issues.length, total: batch.items.length })}</p><p>{t("Dependency links confirmed: {confirmed}/{total}", { confirmed: batch.issues.filter(issue => issue.links_confirmed).length, total: batch.items.length })}</p></div>}
      {batch.items.map(item => {
        const published = batch.issues.find(issue => issue.key === item.key);
        return <article key={item.key} className="factory-issue-deliverable">
          <h4>{published ? <a href={published.url} target="_blank" rel="noreferrer">#{published.number} · {item.title}</a> : item.title}</h4>
          <Markdown>{item.body}</Markdown>
          <strong>{t("Acceptance criteria")}</strong><p>{item.plan.acceptance_criteria}</p>
          <strong>{t("Deliverable boundary")}</strong><p>{item.deliverable}</p>
          <strong>{t("Dependencies")}</strong><ul>{item.dependencies.map(dep => <li key={dep.key}>{batch.items.find(item => item.key === dep.key)?.title} · {dep.requires === "merge" ? t("Verified merge") : t("Containing release")}</li>)}{item.plan.dependencies.map(dep => <li key={`${dep.repository}/${dep.issue_number}`}><a href={`https://github.com/${dep.repository}/issues/${dep.issue_number}`} target="_blank" rel="noreferrer">{dep.repository} #{dep.issue_number}</a> · {dep.requires === "merge" ? t("Verified merge") : t("Containing release")}</li>)}</ul>
          <strong>{t("Confirmed testing seams")}</strong><ul>{item.plan.testing_seams.map(seam => <li key={seam}>{seam}</li>)}</ul>
          <strong>{t("Planning decisions")}</strong><ul>{item.plan.planning_decisions.map(decision => <li key={decision}>{decision}</li>)}</ul>
          <p>{item.ready_for_agent ? t("Agent implementation") : t("Start planning explicitly from Inbox.")}</p>
        </article>;
      })}
      {!policyRevision && <p role="status">{t("Configure Project GitHub before reviewing this batch.")}</p>}
      {batch.problem && <p role="alert">{batch.problem}</p>}
      {!batch.dispatch_ready && batch.intents.length > 0 && <p role="status">{t("The whole batch is held until every issue and dependency link is confirmed.")}</p>}
      {!batch.dispatch_ready && batch.intents.length > 0 && <p>{t("Resume checks GitHub for the same batch before continuing publication.")}</p>}
      {batch.condition !== "confirmed" && <div className="factory-actions factory-issue-batch-actions">
        <button className="btn factory-issue-batch-button" disabled={busy || !policyRevision || batch.intents.length > 0} onClick={() => act(batch, "review")}>{t("Review issue batch")}</button>
        <button className="btn factory-issue-batch-button btn-primary" disabled={busy || !policyRevision || batch.condition !== "reviewed" || batch.review?.policy_revision !== policyRevision} onClick={() => act(batch, "publish")}>{t("Publish issue batch")}</button>
        {(batch.condition === "held" || batch.condition === "publishing") && <button className="btn factory-issue-batch-button btn-primary" disabled={busy || !policyRevision || batch.review?.policy_revision !== policyRevision} onClick={() => act(batch, "resume")}>{t("Resume issue batch")}</button>}
      </div>}
      {batch.intents.length > 0 && <details><summary>{t("Publication receipts")}</summary><ul>{batch.intents.map(intent => <li key={intent.id}>{batch.items.find(item => item.key === intent.item_key)?.title} · {intent.action === "create" ? t("Create issue") : intent.action === "link" ? t("Link dependencies") : t("Apply triage label")} · {intent.condition === "confirmed" ? t("Confirmed") : intent.condition === "uncertain" ? t("Uncertain") : t("Publishing")}{intent.problem && <p role="alert">{intent.problem}</p>}</li>)}</ul></details>}
    </section>)}
  </section>;
}
