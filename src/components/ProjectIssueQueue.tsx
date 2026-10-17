import { useEffect, useRef, useState } from "react";
import type { IssueQueue } from "../../shared/issue-queue.ts";
import { useT } from "../lib/i18n.ts";
import { factoryRequest } from "../lib/factoryApi.ts";
import { accountRequest } from "../lib/accountsApi.ts";
import { IssueQueueStatus } from "./IssueQueueStatus.tsx";
import "./ProjectIssueQueue.css";

type QueueProps = { projectId: string; busy: boolean; perform: (action: () => Promise<void>) => Promise<void> };
function QueueSettings({ queue, save, busy }: { queue: IssueQueue; save: (paused: boolean) => void; busy: boolean }) {
  const t = useT();
  const [paused, setPaused] = useState(queue.policy.paused);
  return <form className="factory-form" onSubmit={event => { event.preventDefault(); save(paused); }}>
    <label><input type="checkbox" checked={paused} onChange={event => setPaused(event.target.checked)} />{t("Pause queue")}</label>
    <button className="btn" disabled={busy}>{t("Save queue settings")}</button>
  </form>;
}

/** The Project is keyed by its parent; pending reads never change another Project. */
export function ProjectIssueQueue({ projectId, busy, perform }: QueueProps) {
  const t = useT(); const route = `/projects/${projectId}/github`;
  const [queue, setQueue] = useState<IssueQueue | null>(null);
  const [problem, setProblem] = useState("");
  const epoch = useRef(0);
  function accept(value: IssueQueue) { epoch.current++; setQueue(value); }
  useEffect(() => {
    let live = true; let pending = false;
    async function refresh() {
      if (pending) return; pending = true; const request = ++epoch.current;
      try { const value = await factoryRequest<IssueQueue>(route + "/queue"); if (live && request === epoch.current) { setQueue(value); setProblem(""); } }
      catch (error) { if (live && request === epoch.current) setProblem(error instanceof Error ? error.message : String(error)); }
      finally { pending = false; }
    }
    void refresh(); const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 5_000);
    return () => { live = false; epoch.current++; clearInterval(timer); };
  }, [route]);
  return <section aria-label={t("Issue queue")} className="factory-section project-issue-queue">
    <h4>{t("Issue queue")}</h4>
    {problem && <p role="alert">{problem}</p>}
    {queue && <>
      <p role="status">{queue.policy.automatic_implementation ? t("Automatic implementation is on.") : t("Automatic implementation is off.")}</p>
      <p>{t("Enabling covers eligible existing and future issues. Checks and independent reviews still apply.")}</p>
      {queue.dispatch_problem && <p role="alert">{t("Automatic implementation is waiting.")} {queue.dispatch_problem.message}</p>}
      <p role="status">{queue.policy.paused ? t("Queue paused. Admitted work continues.") : t("Queue is not paused.")}</p>
      {typeof queue.implementing_count === "number" && <p>{t("Implementing Assignments: {count}", { count: queue.implementing_count })}</p>}
      <QueueSettings key={queue.policy.revision} queue={queue} busy={busy} save={paused => void perform(async () => { accept(await accountRequest<IssueQueue>(route + "/queue", { expected_revision: queue.policy.revision, automatic_implementation: queue.policy.automatic_implementation, paused })); })} />
      <button className="btn" disabled={busy} onClick={() => void perform(async () => { accept(await accountRequest<IssueQueue>(route + "/preview", {})); })}>{t("Preview eligible backlog")}</button>
      <p role="status">{t("Eligible issues: {count}", { count: queue.eligible_count })}</p>
      {queue.preview && <p role="status">{queue.preview_current ? t("Preview is current.") : t("Preview changed. Review the backlog again.")}</p>}
      <button className="btn" disabled={busy || !queue.policy.automatic_implementation && !queue.preview_current} onClick={() => void perform(async () => {
        accept(await accountRequest<IssueQueue>(route + "/queue", { expected_revision: queue.policy.revision, automatic_implementation: !queue.policy.automatic_implementation, preview_revision: queue.preview?.revision, paused: queue.policy.paused }));
      })}>{queue.policy.automatic_implementation ? t("Turn off automatic implementation") : t("Enable automatic implementation")}</button>
      {queue.entries.map(entry => <article key={entry.source_id}>
        <a href={`#factory/${entry.implementation_id}`}>#{entry.number} · {entry.title}</a>
        <IssueQueueStatus entry={entry} />
      </article>)}
    </>}
  </section>;
}
