import { useEffect, useState } from "react";
import type { AccountOverview, AccountProfile } from "../../shared/accounts.ts";
import type { FactoryDetail, FactoryProject } from "../../shared/factory.ts";
import { accountRequest } from "../lib/accountsApi.ts";
import { useT } from "../lib/i18n.ts";
import "./AssignmentDeliveryPanel.css";

export function AssignmentDeliveryPanel({ detail, project, busy, perform }: { detail: FactoryDetail; project?: FactoryProject; busy: boolean; perform: (action: () => Promise<void>) => Promise<void> }) {
  const t = useT();
  const idea = detail.implementation, delivery = idea.delivery;
  const machineId = delivery?.machine_id ?? detail.runs.at(-1)?.machine_id ?? project?.machine_id ?? "local";
  const binding = project?.account_bindings?.[machineId]?.github;
  const [profiles, setProfiles] = useState<AccountProfile[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [accountId, setAccountId] = useState(delivery?.account_profile_id ?? binding ?? "");
  const [numbers, setNumbers] = useState(delivery?.pull_numbers.join(", ") ?? "");
  const prefix = `/implementations/${idea.id}/delivery`;
  const done = idea.stage === "done";
  useEffect(() => {
    setAccountId(delivery?.account_profile_id ?? binding ?? ""); setNumbers(delivery?.pull_numbers.join(", ") ?? "");
  }, [idea.id, delivery?.revision, binding]);
  useEffect(() => {
    if (done) return;
    const abort = new AbortController(); setProfiles([]); setProblem(null);
    void accountRequest<AccountOverview>(`/machines/${encodeURIComponent(machineId)}/accounts`, undefined, abort.signal).then(value => {
      if (!abort.signal.aborted) setProfiles(value.profiles.filter(profile => profile.service === "github" && profile.state === "ready"));
    }).catch(error => { if (!abort.signal.aborted) setProblem(String(error.message)); });
    return () => abort.abort();
  }, [machineId, done, binding]);
  const pulls = numbers.split(/[\s,]+/).filter(Boolean).map(Number);
  const valid = !!accountId && pulls.length > 0 && pulls.length <= 20 && pulls.every(number => Number.isSafeInteger(number) && number > 0) && new Set(pulls).size === pulls.length;
  return <section className="assignment-delivery factory-section" aria-label={t("Delivery evidence")}>
    <h3>{t("Delivery evidence")}</h3>
    <p>{t("Machine")}: {machineId}</p>
    {delivery && <p>{delivery.repository} · {delivery.branch}</p>}
    {delivery?.problem && <p role="alert">{delivery.problem}</p>}
    {problem && <p role="alert">{problem}</p>}
    {!done && <form className="factory-form" onSubmit={event => {
      event.preventDefault();
      if (valid) void perform(async () => { await accountRequest(prefix, { expected_revision: delivery?.revision ?? null, machine_id: machineId, account_profile_id: accountId, pull_numbers: pulls }); });
    }}>
      <p className="field-hint">{t("Link every required delivery PR.")}</p>
      <label>{t("GitHub account")}<select className="select" value={accountId} disabled={busy || !!binding} onChange={event => setAccountId(event.target.value)}>
        <option value="">{t("GitHub account")}</option>
        {profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.name} · {profile.verified_identity?.login}</option>)}
      </select></label>
      <label>{t("Delivery PR numbers")}<input className="input" value={numbers} disabled={busy} onChange={event => setNumbers(event.target.value)} /></label>
      <div className="factory-actions">
        <button className="btn factory-button" disabled={busy || !valid} type="submit">{t("Save delivery links")}</button>
        {delivery && <button type="button" className="btn factory-button" disabled={busy} onClick={() => void perform(async () => { await accountRequest(prefix + "/sync", { expected_revision: delivery.revision }); })}>{t("Sync delivery evidence")}</button>}
      </div>
    </form>}
    {delivery && ["merged", "released"].includes(delivery.condition) && <p role="status">{t("Verified merge")}</p>}
    {delivery?.release && <div>
      <p role="status">{t("Verified release")}</p>
      <p><a href={delivery.release.url} target="_blank" rel="noreferrer">{t("Containing release")} {delivery.release.tag}</a> · <code>{delivery.release.commit}</code></p>
      <p>{t("Published at")}: <time dateTime={delivery.release.published_at}>{delivery.release.published_at}</time></p>
    </div>}
    {delivery && <ul>{delivery.pull_numbers.map(number => {
      const pull = delivery.pulls.find(pull => pull.number === number);
      return <li key={number}><a href={`https://github.com/${delivery.repository}/pull/${number}`} target="_blank" rel="noreferrer">PR #{number}</a>{pull && <> · <code>{pull.merge_commit}</code><p>{t("Covered changes")}: {pull.covered_paths.join(", ")}</p></>}</li>;
    })}</ul>}
    {!!delivery?.changes.length && <div><h4>{t("Intended changes")}</h4><ul>{delivery.changes.map(file => <li key={file.path}><code>{file.path}</code></li>)}</ul></div>}
  </section>;
}
