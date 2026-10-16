import { useEffect, useState } from "react";
import type { ProjectSchedulesOverview } from "../../shared/project-schedules.ts";
import type { UpstreamRelease } from "../../shared/upstream-releases.ts";
import { factoryRequest } from "../lib/factoryApi.ts";
import { useT } from "../lib/i18n.ts";
import "./ProjectUpstreamStatus.css";

export function UpstreamReleaseStatus({ view }: { view: ProjectSchedulesOverview | null }) {
  const t = useT();
  const state = view?.upstream;
  if (!state?.repository) return null;
  const result = view?.results.filter(result => result.job === "upstream_sync").at(-1);
  const release = (value: UpstreamRelease) => <><a href={value.url} target="_blank" rel="noreferrer">{value.repository} · {value.tag}</a><code>{value.revision}</code></>;
  return <section className="project-upstream-status" aria-label={t("Upstream releases")}>
    <h2>{t("Upstream releases")}</h2>
    <p>{state.repository}</p>
    <p className="field-hint">{t("Upstream releases enter Inbox for planning.")}</p>
    <div><p>{state.detected ? t("Detected release: {tag}", { tag: state.detected.tag }) : t("No release detected")}</p>{state.detected && release(state.detected)}</div>
    <div>{state.active ? <><a className="project-upstream-active" href={`#factory/${state.active.implementation_id}`}>{t("Active update: {tag}", { tag: state.active.release.tag })}</a>{release(state.active.release)}</> : <p>{t("No active update")}</p>}</div>
    <div><p>{state.candidate ? t("Next release: {tag}", { tag: state.candidate.tag }) : t("No next release")}</p>{state.candidate && release(state.candidate)}</div>
    {result && <div role="status"><p>{t("Sync results")}: <time dateTime={result.started_at}>{new Date(result.started_at).toLocaleString()}</time> · <span>{result.condition === "succeeded" ? t("Succeeded") : result.condition === "failed" ? t("Failed") : result.condition === "uncertain" ? t("Uncertain") : result.condition === "reconciled" ? t("Reconciled") : t("Running")}</span></p>{result.problem && <p>{result.problem}</p>}</div>}
  </section>;
}

export function ProjectUpstreamStatus({ projectId }: { projectId: string }) {
  const [view, setView] = useState<ProjectSchedulesOverview | null>(null);
  const [problem, setProblem] = useState("");
  useEffect(() => {
    let live = true, loading = false;
    setView(null); setProblem("");
    const load = async () => {
      if (loading || document.hidden) return;
      loading = true;
      try {
        const next = await factoryRequest<ProjectSchedulesOverview>(`/projects/${projectId}/github/schedules`);
        if (live) { setView(next); setProblem(""); }
      } catch (error) { if (live) setProblem((error as Error).message); }
      finally { loading = false; }
    };
    void load();
    const timer = setInterval(() => void load(), 10000);
    window.addEventListener("factory-changed", load); document.addEventListener("visibilitychange", load);
    return () => { live = false; clearInterval(timer); window.removeEventListener("factory-changed", load); document.removeEventListener("visibilitychange", load); };
  }, [projectId]);
  return <>{problem && <p role="alert">{problem}</p>}<UpstreamReleaseStatus view={view} /></>;
}
