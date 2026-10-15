import type { FactoryDetail } from "../../shared/factory.ts";
import { useT } from "../lib/i18n.ts";

/** Automatic progress is visible alongside the conversation, without opening controls. */
export function FactoryAutomaticExecution({ detail, onOpenPane }: { detail: FactoryDetail; onOpenPane: (machineId: string, paneId: string) => void }) {
  const t = useT();
  const plan = detail.execution_plans?.at(-1);
  const run = detail.runs.find(r => r.id === plan?.run_id);
  if (!plan || !run) return null;
  const progress = detail.automatic_execution?.find(p => p.run_id === run.id);
  const workers = detail.workers.filter(w => w.run_id === run.id);
  const checks = detail.checks.filter(c => c.run_id === run.id);
  const title = (ticketId: string) => plan.tickets.find(t => t.id === ticketId)?.title ?? ticketId;
  return <section className="factory-section" aria-label={t("Automatic execution")}>
    <h3>{t("Automatic execution")}</h3>
    <p>{t("Tickets, checks and integration continue automatically.")}</p>
    {progress && <p role={progress.condition === "blocked" ? "alert" : "status"}><strong>{progress.condition}</strong>{progress.reason && <> · {progress.reason}</>}</p>}
    {workers.map(worker => <article className="factory-message" key={worker.id}>
      <strong>{title(worker.ticket_id)}</strong><p>{worker.role} · {worker.condition}</p>
      {worker.waiting_reason && <p role="status">{worker.waiting_reason}</p>}
      {worker.pane_id && <button className="btn factory-button" onClick={() => onOpenPane(run.machine_id, worker.pane_id!)}>{t("Open agent")}</button>}
    </article>)}
    {checks.map(check => <details key={check.id}>
      <summary>{t("Checks")} · {check.condition} · {check.worker_id ? title(workers.find(w => w.id === check.worker_id)?.ticket_id ?? "") : run.branch}</summary>
      {check.commands.map((command, index) => <div key={index}><p>{command.args.join(" ")} · {command.exit_code}</p><pre>{command.output}</pre></div>)}
    </details>)}
  </section>;
}
