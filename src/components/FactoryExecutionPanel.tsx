import { useState } from "react";
import type { FactoryRequestBody, FactoryDetail, FactoryProject } from "../../shared/protocol.ts";
import { factoryRequest } from "../lib/factoryApi.ts";
import { useT } from "../lib/i18n.ts";

export function FactoryExecutionPanel({ detail, project, busy, perform, onOpenPane }: { detail: FactoryDetail; project?: FactoryProject; busy: boolean; perform: (action: () => Promise<void>) => Promise<void>; onOpenPane: (machineId: string, paneId: string) => void }) {
  const t = useT();
  const run = detail.runs.at(-1);
  const [shared, setShared] = useState<string[]>([]);
  const [reworkTicket, setReworkTicket] = useState(detail.tickets[0]?.id ?? "");
  if (!run?.checkout) return null;
  const prefix = `/runs/${run.id}`;
  const active = ["working", "needs_you", "blocked"].includes(run.condition);
  const command = (path: string, body: FactoryRequestBody = {}) => perform(async () => { await factoryRequest(`${prefix}${path}`, body); });
  const check = detail.checks.filter((entry) => entry.worker_id === null && entry.run_id === run.id).at(-1);
  return <section className="factory-section">
    <h3>{t("Execution evidence")}</h3>
    <p>{run.branch} · {run.base}</p>
    {run.action === "implement-spec" && <>
      <h4>{t("Ready Tickets")}</h4>
      {(project?.shared_paths ?? []).map((path) => <label key={path}><input type="checkbox" checked={shared.includes(path)} onChange={(event) => setShared((paths) => event.target.checked ? [...paths, path] : paths.filter((entry) => entry !== path))} />{t("Claim shared document")} · {path}</label>)}
      {detail.frontier.map((ticket) => <article className="factory-message" key={ticket.id}>
        <strong>{ticket.title}</strong><p>{ticket.acceptance}</p>
        <button className="btn factory-button" disabled={busy || !active} onClick={() => void command("/workers", { role: "implementer", ticket_id: ticket.id, shared_paths: shared, idempotency_key: crypto.randomUUID() })}>{t("Start Ticket worker")}</button>
      </article>)}
      <label>{t("Tickets")}<select className="select factory-input" value={reworkTicket} onChange={(event) => setReworkTicket(event.target.value)}>{detail.tickets.map((ticket) => <option key={ticket.id} value={ticket.id}>{ticket.title}</option>)}</select></label>
      {[...new Set(detail.comments.filter((comment) => comment.run_id === run.id && comment.batch_id && comment.status !== "resolved").map((comment) => comment.batch_id!))].map((batch) => <button className="btn factory-button" key={batch} disabled={busy || !active || !reworkTicket} onClick={() => void command("/workers", { role: "implementer", ticket_id: reworkTicket, review_batch_id: batch, shared_paths: shared, idempotency_key: crypto.randomUUID() })}>{t("Start rework worker")} · {batch}</button>)}
    </>}
    {detail.workers.map((worker) => <article className="factory-message" key={worker.id}>
      <strong>{worker.role}</strong><p>{worker.condition} · {worker.branch}</p>
      {worker.waiting_reason && <p role="status">{worker.waiting_reason}</p>}
      <div className="factory-actions">
        {worker.pane_id && <button className="btn factory-button" onClick={() => onOpenPane(run.machine_id, worker.pane_id!)}>{t("Open agent")}</button>}
        <button className="btn factory-button" disabled={busy || !active} onClick={() => void command(`/workers/${worker.id}/reconcile`)}>{t("Reconcile Run")}</button>
        {worker.role === "implementer" ? <>
          <button className="btn factory-button" disabled={busy || !active} onClick={() => void command(`/workers/${worker.id}/refresh`)}>{t("Reconcile integration tip")}</button>
          <button className="btn factory-button" disabled={busy || !active} onClick={() => void command(`/workers/${worker.id}/check`)}>{t("Run checks")}</button>
          <button className="btn factory-button" disabled={busy || !active} onClick={() => void command(`/workers/${worker.id}/integrate`)}>{t("Integrate Ticket")}</button>
        </> : <button className="btn factory-button" disabled={busy || !active} onClick={() => void command(`/workers/${worker.id}/review-evidence`)}>{t("Retain review report")}</button>}
        <button className="btn factory-button" disabled={busy || !active || worker.condition === "cancelled"} onClick={() => void command(`/workers/${worker.id}/stop`)}>{t("Stop worker")}</button>
      </div>
    </article>)}
    <div className="factory-actions">
      <button className="btn factory-button" disabled={busy || !active} onClick={() => void command("/checks")}>{t("Run integration checks")}</button>
      <button className="btn factory-button" disabled={busy || !active} onClick={() => void command("/workers", { role: "standards", idempotency_key: crypto.randomUUID() })}>{t("Start Standards review")}</button>
      <button className="btn factory-button" disabled={busy || !active} onClick={() => void command("/workers", { role: "spec", idempotency_key: crypto.randomUUID() })}>{t("Start Spec review")}</button>
      <button className="btn factory-button" disabled={busy || !active || check?.condition !== "passed"} onClick={() => void command("/accept", { head: check?.head ?? "" })}>{t("Accept reviewed head")}</button>
    </div>
    {detail.checks.map((entry) => <details key={entry.id}><summary>{t("Checks")} · {entry.condition} · {entry.head}</summary><button className="btn factory-button" disabled={busy} onClick={() => void perform(async () => { await factoryRequest(`/runs/${entry.run_id}/checks/${entry.id}/reconcile`, {}); })}>{t("Reconcile checks")}</button>{entry.commands.map((command, index) => <div key={index}><p>{command.args.join(" ")} · {command.exit_code}</p><pre>{command.output}</pre></div>)}</details>)}
    {detail.review_evidence.map((report) => <details key={report.id}><summary>{report.axis} · {report.outcome} · {report.head}</summary><pre>{report.content}</pre></details>)}
  </section>;
}
