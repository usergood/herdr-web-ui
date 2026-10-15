import type { FactoryRun } from "../../shared/factory.ts";
import type { IssueAdmission } from "../../shared/issue-admission.ts";
import { useT } from "../lib/i18n.ts";
import { Markdown } from "./Markdown.tsx";

export function IssueRunContract({ run }: { run: FactoryRun }) {
  const t = useT();
  const admitted = (run.manifest as { issue_admission?: IssueAdmission }).issue_admission;
  if (!admitted) return null;
  return <section className="factory-section assignment-issue-source" aria-label={t("Admitted issue contract")}>
    <h3>{t("Admitted issue contract")}</h3>
    <p>{t("The admitted scope stays fixed. Required checks and independent reviews still apply.")}</p>
    <p>{admitted.source.current?.title}</p>
    <p>{admitted.source.revision}</p>
    <p>{t("Approved by {login}", { login: admitted.planning.authorization.approval.actor.login })}</p>
    {run.issue_pause && <div role="status">
      <p>{run.issue_pause.reason === "issue_closed" ? t("Controlled pause requested. Issue closed.") : run.issue_pause.reason === "readiness_revoked" ? t("Controlled pause requested. Issue readiness was revoked.") : t("Controlled pause requested. Issue scope changed.")}</p>
      <p>{t("Produced work is retained. Reconcile active or unreachable workers before another attempt.")}</p>
    </div>}
    <details><summary>{t("Reused planning")}</summary>
      <Markdown>{admitted.planning.content}</Markdown>
      <h4>{t("Testing seams")}</h4><Markdown>{admitted.planning.testing_seams}</Markdown>
      <p>{admitted.planning.graph_hash}</p>
    </details>
  </section>;
}
