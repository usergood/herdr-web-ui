import type { FactoryRun } from "../../shared/factory.ts";
import type { IssueAdmission, IssueAdmissionSummary } from "../../shared/issue-admission.ts";
import { factoryRequest } from "../lib/factoryApi.ts";
import { useT } from "../lib/i18n.ts";
import { Markdown } from "./Markdown.tsx";

export function IssueRunContract({ run, busy, perform, compact = false }: { compact?: boolean; run: FactoryRun; busy: boolean; perform: (action: () => Promise<void>) => Promise<void> }) {
  const t = useT();
  const admitted = (run.manifest as { issue_admission?: IssueAdmission | IssueAdmissionSummary }).issue_admission;
  if (!admitted) return null;
  const planning = compact ? null : (admitted as IssueAdmission).planning;
  return <section className="factory-section assignment-issue-source" aria-label={t("Admitted issue contract")}>
    <h3>{t("Admitted issue contract")}</h3>
    <p>{t("The admitted scope stays fixed. Required checks and independent reviews still apply.")}</p>
    {run.condition === "failed" && <p role="alert">{t("Attempt failed. Use Retry to start again.")}</p>}
    {["accepted", "disconnected", "interrupted"].includes(run.condition) && <div role="status"><p>{t("Reconciliation required. Ownership remains reserved.")}</p><button className="btn" disabled={busy} onClick={() => void perform(async () => { await factoryRequest(`/runs/${run.id}/reconcile`, {}); })}>{t("Reconcile Run")}</button></div>}
    {["working", "ready"].includes(run.condition) && <p role="status">{t("Execution confirmed.")}</p>}
    <p>{admitted.source.current?.title}</p>
    <p>{admitted.source.revision}</p>
    <p>{t("Approved by {login}", { login: admitted.planning.authorization.approval.actor.login })}</p>
    {run.issue_pause && <div role="status">
      <p>{run.issue_pause.reason === "issue_closed" ? t("Controlled pause requested. Issue closed.") : run.issue_pause.reason === "readiness_revoked" ? t("Controlled pause requested. Issue readiness was revoked.") : t("Controlled pause requested. Issue scope changed.")}</p>
      <p>{t("Produced work is retained. Reconcile active or unreachable workers before another attempt.")}</p>
    </div>}
    {planning && <details><summary>{t("Reused planning")}</summary>
      <Markdown>{planning.content}</Markdown>
      <h4>{t("Testing seams")}</h4><Markdown>{planning.testing_seams}</Markdown>
      <p>{planning.graph_hash}</p>
    </details>}
  </section>;
}
