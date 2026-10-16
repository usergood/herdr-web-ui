import type { FactoryCurrent } from "../../shared/factory.ts";
import { FactoryDetailSection } from "./FactoryDetailSection.tsx";
import { FactoryReport } from "./FactoryReport.tsx";
import { useT } from "../lib/i18n.ts";

/** Automatic progress is visible alongside the conversation, without opening controls. */
export function FactoryAutomaticExecution({ detail, onOpenPane }: { detail: FactoryCurrent; onOpenPane: (machineId: string, paneId: string) => void }) {
  const t = useT();
  const plan = detail.execution_plans?.at(-1);
  const run = detail.runs.find(r => r.id === plan?.run_id);
  if (!plan || !run) return null;
  const progress = detail.automatic_execution?.find(p => p.run_id === run.id);
  const workers = detail.workers.filter(w => w.run_id === run.id);
  const checks = detail.checks.filter(c => c.run_id === run.id);
  const review = detail.automatic_review?.find(r => r.run_id === run.id);
  const pr = detail.pull_requests?.find(p => p.run_id === run.id);
  const reports = detail.review_evidence.filter(r => r.run_id === run.id);
  const pause = detail.implementation.pause;
  const title = (ticketId: string) => plan.tickets.find(t => t.id === ticketId)?.title ?? ticketId;
  return <section className="factory-section" aria-label={t("Automatic execution")}>
    <h3>{t("Automatic execution")}</h3>
    {!pause && <p>{t("Tickets, checks, reviews, repairs and PR publication continue automatically.")}</p>}
    {progress && <p role={!pause && progress.condition === "blocked" ? "alert" : "status"}><strong>{pause ? pause.condition === "paused" ? t("Paused") : t("Pause pending") : progress.condition}</strong>{!pause && progress.reason && <> · {progress.reason}</>}</p>}
    {workers.map(worker => <article className="factory-message" key={worker.id}>
      <strong>{worker.role === "standards" ? t("Standards") : worker.role === "spec" ? t("Spec") : worker.rework_batch_id ? `${t("Review-fixes")} · ${title(worker.ticket_id)}` : title(worker.ticket_id)}</strong><p>{worker.role} · {worker.suspension?.condition === "stopped" ? t("Paused") : worker.condition}</p>
      {worker.waiting_reason && <p role="status">{worker.waiting_reason}</p>}
      {worker.pane_id && <button className="btn factory-button" onClick={() => onOpenPane(run.machine_id, worker.pane_id!)}>{t("Open agent")}</button>}
    </article>)}
    {checks.map(check => <FactoryDetailSection key={check.id} id={detail.implementation.id} revision={detail.revision} title={`${t("Checks")} · ${check.condition} · ${check.head.slice(0, 12)} · ${check.worker_id ? title(workers.find(w => w.id === check.worker_id)?.ticket_id ?? "") : run.branch}`}>
      {full => full.checks.find(entry => entry.id === check.id)?.commands.map((command, index) => <div key={index}><p>{command.args.join(" ")} · {command.exit_code}</p><pre>{command.output}</pre></div>)}
    </FactoryDetailSection>)}
    {review && <section className="factory-section" aria-label={t("Automatic review and PR")}>
      <h3>{t("Automatic review and PR")}</h3>
      <p role={!pause && review.condition === "blocked" ? "alert" : "status"}><strong>{pause ? pause.condition === "paused" ? t("Paused") : t("Pause pending") : review.condition === "published" ? t("PR published") : review.condition === "publishing" ? t("Publishing PR") : review.condition === "repairing" ? t("Fixing") : review.condition === "blocked" ? t("Blocked") : review.condition === "waiting" ? t("Waiting") : t("Reviewing")}</strong>{!pause && review.reason && <> · {review.reason}</>}</p>
      {pr && <p><a href={pr.url} target="_blank" rel="noopener noreferrer">{t("Open PR")}</a> · #{pr.number}</p>}
      {reports.map(report => <details className="factory-message" key={report.id}>
        <summary>{report.axis === "standards" ? t("Standards") : t("Spec")} · {report.outcome} · {report.head.slice(0, 12)}</summary>
        <FactoryReport assignmentId={detail.implementation.id} reportId={report.id} />
      </details>)}
    </section>}
  </section>;
}
