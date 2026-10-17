import { useEffect, useRef, useState } from "react";
import type { ProjectQueueOverview } from "../../shared/project-queue.ts";
import { factoryRequest } from "../lib/factoryApi.ts";
import { useT } from "../lib/i18n.ts";
import { SettingsGroup, SettingsRow, Toggle } from "./SettingsControls.tsx";
import "./ProjectQueue.css";

function reasonLabel(reason: string, t: ReturnType<typeof useT>): string {
  switch (reason) {
    case "queue_paused": return t("Queue paused");
    case "agent_capacity": return t("Execution capacity reserved");
    case "implementation_owned": return t("Accepted work retains ownership");
    case "retry_required": return t("Owner Retry required");
    case "awaiting_delivery": return t("Awaiting merge");
    case "dependency_unverified": return t("Waiting for verified dependencies");
    case "batch_incomplete": return t("Issue batch publication incomplete");
    case "start_planning": case "planning_required": return t("Start planning explicitly from Inbox.");
    case "approval_required": return t("Approval of this issue revision is required.");
    case "automatic_implementation_disabled": return t("Automatic implementation is disabled for this Project.");
    case "human_only": return t("This issue requires human implementation.");
    case "wontfix": return t("This issue will not be actioned.");
    case "conflicting_triage": return t("Correct conflicting triage labels.");
    case "issue_closed": return t("This issue is closed.");
    default: return t("Waiting for verification");
  }
}

export function ProjectQueue({ projectId }: { projectId: string }) {
  const t = useT();
  const route = `/projects/${projectId}/queue`;
  const epoch = useRef(0);
  const [view, setView] = useState<ProjectQueueOverview | null>(null);
  const [busy, setBusy] = useState(false), [problem, setProblem] = useState("");
  useEffect(() => {
    const generation = ++epoch.current; let loading = false;
    setView(null); setProblem("");
    const load = async () => {
      if (loading) return; loading = true;
      try { const next = await factoryRequest<ProjectQueueOverview>(route); if (generation === epoch.current) { setView(next); setProblem(""); } }
      catch (error) { if (generation === epoch.current) setProblem((error as Error).message); }
      finally { loading = false; }
    };
    void load();
    const refresh = () => { if (!document.hidden) void load(); };
    const timer = setInterval(refresh, 10000);
    window.addEventListener("factory-changed", refresh); document.addEventListener("visibilitychange", refresh);
    return () => { epoch.current++; clearInterval(timer); window.removeEventListener("factory-changed", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [route]);
  async function act(path: string, body: Parameters<typeof factoryRequest>[1]) {
    if (busy) return; const generation = epoch.current; setBusy(true); setProblem("");
    try { await factoryRequest(path, body); const next = await factoryRequest<ProjectQueueOverview>(route); if (generation === epoch.current) { setView(next); } }
    catch (error) { if (generation === epoch.current) setProblem((error as Error).message); }
    finally { if (generation === epoch.current) setBusy(false); }
  }
  return <section className="project-queue" aria-label={t("Project queue")}>
    {problem && <p role="alert">{problem}</p>}{!view && !problem && <p role="status">{t("Loading…")}</p>}
    {view && <>
      <SettingsGroup title={t("Queue")}>
        <SettingsRow label={t("Pause queue")} description={t("Existing work continues while the queue is paused.")}><Toggle label={t("Pause queue")} checked={view.paused} disabled={busy} onChange={paused => void act(route + "/configure", { expected_revision: view.revision, paused })} /></SettingsRow>
      </SettingsGroup>
      <p role="status">{t("Agent contexts: {used}/{limit}", { used: view.capacity.agents, limit: view.capacity.max_agents })}</p>
      <p role="status">{t("Builds: {used}/{limit}", { used: view.capacity.builds, limit: view.capacity.max_builds })}</p>
      <SettingsGroup title={t("Queued")} note={t("Queued work starts automatically when capacity is available.")}>
        <ol className="project-queue-list">{view.items.map(item => <li key={item.implementation_id}>
          <a href={`#factory/${item.implementation_id}`}>{item.title}</a>
          <p>{item.eligible ? t("Eligible") : [...new Set(item.reasons.map(reason => reasonLabel(reason, t)))].join(" · ")}</p>
          {item.problem && <p role="alert">{item.problem}</p>}
          <div className="project-queue-actions">
            {item.failed_run_id && item.reasons.includes("retry_required") && <button className="btn project-queue-button" disabled={busy || item.reasons.includes("implementation_owned")} onClick={() => void act(`/implementations/${item.implementation_id}/retry`, { run_id: item.failed_run_id! })}>{t("Retry")}</button>}
          </div>
        </li>)}</ol>
      </SettingsGroup>
    </>}
  </section>;
}
