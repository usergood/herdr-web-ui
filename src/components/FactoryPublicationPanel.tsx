import { useEffect, useState } from "react";
import type { FactoryDetail } from "../../shared/factory.ts";
import type { PublicationOverview } from "../../shared/factory-publication.ts";
import { accountRequest } from "../lib/accountsApi.ts";
import { useT } from "../lib/i18n.ts";
import "./FactoryPublicationPanel.css";

export function FactoryPublicationPanel({ detail, busy, perform }: { detail: FactoryDetail; busy: boolean; perform: (action: () => Promise<void>) => Promise<void> }) {
  const t = useT(), run = detail.runs.at(-1);
  const [title, setTitle] = useState(detail.implementation.title);
  const [body, setBody] = useState(detail.implementation.description);
  const [view, setView] = useState<PublicationOverview | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const route = run ? `/runs/${run.id}/publication` : null;
  useEffect(() => {
    setView(null); setProblem(null);
    if (!route || !run?.accepted_result) return;
    const abort = new AbortController();
    void accountRequest<PublicationOverview>(route, undefined, abort.signal).then(next => { if (!abort.signal.aborted) setView(next); }).catch(error => { if (!abort.signal.aborted) setProblem(error.message); });
    return () => abort.abort();
  }, [route, run?.accepted_result?.head, detail.implementation.updated_at]);
  if (!route || !run?.accepted_result || detail.implementation.stage === "done") return null;
  const current = view?.run_id === run.id ? view : null;
  const publication = current?.publication;
  const act = (action: "publish" | "reconcile") => perform(async () => {
    await accountRequest(`${route}/${action}`, action === "publish" ? { head: current?.head, title, body } : {});
    setView(await accountRequest<PublicationOverview>(route));
  });
  return <section className="implementation-publication factory-section" aria-label={t("Implementation PR")}>
    <h3>{t("Implementation PR")}</h3>
    <p>{current?.repository} · {current?.target_branch}</p>
    <p>{current?.branch}</p><p><code>{run.accepted_result.head}</code></p>
    {(problem || current?.problem || publication?.problem) && <p role="alert">{problem ?? publication?.problem ?? current?.problem}</p>}
    {publication?.condition === "confirmed" && publication.pull ? <>
      <p role="status">{t("Awaiting merge")}</p>
      <a href={publication.pull.url} target="_blank" rel="noreferrer">PR #{publication.pull.number}</a>
    </> : publication && publication.condition !== "prepared" ? <>
      <p role="status">{t("Publication needs reconciliation")}</p>
      <button className="btn factory-button" disabled={busy} onClick={() => void act("reconcile")}>{t("Reconcile PR publication")}</button>
    </> : <><label>{t("PR title")}<input className="input" value={title} maxLength={200} disabled={busy || !!publication} onChange={event => setTitle(event.target.value)} /></label><label>{t("Problem and resulting behavior")}<textarea className="input" value={body} maxLength={50_000} disabled={busy || !!publication} onChange={event => setBody(event.target.value)} /></label><button className="btn factory-button" disabled={busy || !current?.eligible} onClick={() => void act("publish")}>{t("Publish PR")}</button></>}
  </section>;
}
