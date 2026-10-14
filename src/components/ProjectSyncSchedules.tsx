import { useEffect, useId, useRef, useState } from "react";
import type { ProjectSchedulesOverview, ProjectSyncSchedule } from "../../shared/project-schedules.ts";
import { factoryRequest } from "../lib/factoryApi.ts";
import { accountRequest } from "../lib/accountsApi.ts";
import { useT } from "../lib/i18n.ts";
import { SettingsGroup, SettingsRow, Toggle } from "./SettingsControls.tsx";
import { UpstreamReleaseStatus } from "./ProjectUpstreamStatus.tsx";
import "./ProjectSyncSchedules.css";

export function ProjectSyncSchedules({ projectId, configured, busy, perform, onSaved }: { projectId: string; configured: boolean; busy: boolean; perform: (action: () => Promise<void>) => Promise<void>; onSaved: () => Promise<void> }) {
  const t = useT(), id = useId();
  const route = `/projects/${projectId}/github/schedules`, epoch = useRef(0);
  const [forms, setForms] = useState<ProjectSyncSchedule[]>([]);
  const [view, setView] = useState<ProjectSchedulesOverview | null>(null);
  const [problem, setProblem] = useState("");
  useEffect(() => {
    const generation = ++epoch.current;
    setForms([]); setView(null); setProblem("");
    let loading = false;
    const load = async (initial = false) => {
      if (loading) return;
      loading = true;
      try { const next = await factoryRequest<ProjectSchedulesOverview>(route); if (generation === epoch.current) { setView(next); if (initial) setForms(next.schedules); setProblem(""); } }
      catch (error) { if (generation === epoch.current) setProblem((error as Error).message); }
      finally { loading = false; }
    };
    void load(true);
    const refresh = () => { if (!document.hidden) void load(); };
    const timer = setInterval(refresh, 10000);
    window.addEventListener("factory-changed", refresh); document.addEventListener("visibilitychange", refresh);
    return () => { epoch.current++; clearInterval(timer); window.removeEventListener("factory-changed", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [route]);
  const change = (job: ProjectSyncSchedule["job"], value: Partial<ProjectSyncSchedule>) => setForms(current => current.map(form => form.job === job ? { ...form, ...value } : form));
  const condition = (value: string) => value === "running" ? t("Running") : value === "failed" ? t("Failed") : value === "uncertain" ? t("Uncertain") : value === "succeeded" ? t("Succeeded") : value === "reconciled" ? t("Reconciled") : t("Ready");
  async function act(action: string, form: ProjectSyncSchedule) {
    const generation = epoch.current;
    await perform(async () => {
      try {
        const { job, enabled, cadence, interval_minutes, local_time, time_zone, revision } = form;
        const result = view?.results.filter(result => result.job === job && result.condition === "uncertain").at(-1);
        const next = await accountRequest<ProjectSchedulesOverview>(`${route}/${action}`, action === "configure" ? { job, enabled, cadence, interval_minutes, local_time, time_zone, expected_revision: revision } : { job, ...(action === "reconcile" ? { result_id: result?.id } : {}) });
        if (generation !== epoch.current) return;
        setView(next); setProblem("");
        if (action === "configure") setForms(current => current.map(value => value.job === job ? next.schedules.find(value => value.job === job)! : value));
        await onSaved();
      } finally {
        if (generation === epoch.current) {
          try { const next = await factoryRequest<ProjectSchedulesOverview>(route); if (generation === epoch.current) setView(next); }
          catch (error) { if (generation === epoch.current) setProblem((error as Error).message); }
        }
      }
    });
  }
  return <div className="project-sync-schedules">
    <UpstreamReleaseStatus view={view} />
    <p className="field-hint">{t("Sync retries only synchronize Project data; implementation Retry remains an owner action.")}</p>
    <button type="button" className="btn" disabled={busy} onClick={() => void perform(async () => { const generation = epoch.current; const next = await factoryRequest<ProjectSchedulesOverview>(route); if (generation === epoch.current) { setView(next); setForms(next.schedules); setProblem(""); } })}>{t("Refresh schedules")}</button>
    {problem && <p role="alert">{problem}</p>}
    {forms.map(form => {
      const saved = view?.schedules.find(value => value.job === form.job) ?? form;
      const results = view?.results.filter(result => result.job === form.job) ?? [];
      return <section className="project-sync-schedule" role="region" aria-label={form.job === "github_sync" ? t("GitHub sync schedule") : t("Upstream sync schedule")} key={form.job}>
      <form onSubmit={event => { event.preventDefault(); void act("configure", form); }}>
      <SettingsGroup title={form.job === "github_sync" ? t("GitHub sync schedule") : t("Upstream sync schedule")}>
        <SettingsRow label={t("Enable schedule")}><Toggle label={t("Enable schedule")} checked={form.enabled} onChange={enabled => change(form.job, { enabled })} /></SettingsRow>
        <SettingsRow label={t("Schedule frequency")} htmlFor={`${id}-${form.job}-frequency`} wide><select className="select project-sync-input" id={`${id}-${form.job}-frequency`} value={form.cadence} onChange={event => change(form.job, { cadence: event.target.value as ProjectSyncSchedule["cadence"] })}><option value="interval">{t("Every interval")}</option><option value="daily">{t("Daily")}</option></select></SettingsRow>
        {form.cadence === "interval" ? <SettingsRow label={t("Interval (minutes)")} htmlFor={`${id}-${form.job}-interval`} wide><input className="input project-sync-input" type="number" min={5} max={1440} id={`${id}-${form.job}-interval`} value={form.interval_minutes} onChange={event => change(form.job, { interval_minutes: Number(event.target.value) })} /></SettingsRow> : <SettingsRow label={t("Local time")} htmlFor={`${id}-${form.job}-time`} wide><input className="input project-sync-input" type="time" id={`${id}-${form.job}-time`} value={form.local_time} onChange={event => change(form.job, { local_time: event.target.value })} /></SettingsRow>}
        <SettingsRow label={t("Time zone")} htmlFor={`${id}-${form.job}-zone`} wide><input className="input project-sync-input" id={`${id}-${form.job}-zone`} value={form.time_zone} onChange={event => change(form.job, { time_zone: event.target.value })} /></SettingsRow>
        <div className="settings-item"><div className="settings-actions">
          <button className="btn" disabled={busy || saved.condition === "running"}>{t("Save schedule")}</button>
          <button type="button" className="btn" disabled={busy || saved.condition === "running" || saved.condition === "uncertain" || form.job === "github_sync" && !configured} onClick={() => void act("run", form)}>{t("Run now")}</button>
          {saved.condition === "uncertain" && <button type="button" className="btn" disabled={busy} onClick={() => void act("reconcile", form)}>{t("Reconcile sync")}</button>}
        </div>
        <p role="status">{condition(saved.condition)}</p>
        <p>{t("Next execution")}: {saved.next_execution ? <time dateTime={saved.next_execution}>{new Date(saved.next_execution).toLocaleString(undefined, { timeZone: saved.time_zone })} · {saved.time_zone}</time> : t("No scheduled execution")}</p>
        {saved.retry_at && <p>{t("Sync retry")}: <time dateTime={saved.retry_at}>{new Date(saved.retry_at).toLocaleString(undefined, { timeZone: saved.time_zone })} · {saved.time_zone}</time></p>}
        {saved.condition === "failed" && !saved.retry_at && <p>{t("Automatic retries stopped. Correct the problem and choose Run now.")}</p>}
        </div>
      </SettingsGroup>
      </form>
      {results.length > 0 && <details open className="project-sync-results"><summary>{t("Sync results")}</summary><ol>{results.slice(-20).reverse().map(result => <li key={result.id}>
        <time dateTime={result.started_at}>{new Date(result.started_at).toLocaleString(undefined, { timeZone: saved.time_zone })}</time> · <span>{condition(result.condition)}</span>
        {result.problem && <p role={result.condition === "failed" || result.condition === "uncertain" ? "alert" : undefined}>{result.problem}</p>}
      </li>)}</ol></details>}
    </section>; })}
  </div>;
}
