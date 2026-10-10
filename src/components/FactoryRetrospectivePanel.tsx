import { useState } from "react";
import type { FactoryDetail, FactoryRetrospective } from "../../shared/protocol.ts";
import { factoryRequest } from "../lib/factoryApi.ts";
import { useT } from "../lib/i18n.ts";

export function FactoryRetrospectivePanel({ detail, busy, perform }: { detail: FactoryDetail; busy: boolean; perform: (action: () => Promise<void>) => Promise<void> }) {
  const t = useT(); const [selected, setSelected] = useState<string[]>([]); const [proposal, setProposal] = useState("");
  if (!detail.implementation.project_id) return null;
  const evidence = [...detail.runs.map((entry) => ({ id: entry.id, label: `${entry.action}: ${entry.condition}` })), ...detail.artifacts.map((entry) => ({ id: entry.id, label: entry.name })), ...detail.checks.map((entry) => ({ id: entry.id, label: `${t("Checks")}: ${entry.head}` })), ...detail.messages.map((entry) => ({ id: entry.id, label: entry.content.slice(0, 100) }))];
  const start = (retro: FactoryRetrospective, action: "retro" | "apply-retro") => perform(async () => { await factoryRequest(`/implementations/${detail.implementation.id}/runs`, { action, retrospective_id: retro.id, idempotency_key: crypto.randomUUID() }); });
  return <section className="factory-section"><h3>{t("Project retrospective")}</h3>
    <form className="factory-form" onSubmit={(event) => { event.preventDefault(); void perform(async () => { await factoryRequest(`/projects/${detail.implementation.project_id}/retrospectives`, { evidence_ids: selected, proposal }); setSelected([]); setProposal(""); }); }}>
      <fieldset><legend>{t("Select evidence")}</legend>{evidence.map((entry) => <label key={entry.id}><input type="checkbox" checked={selected.includes(entry.id)} onChange={(event) => setSelected((ids) => event.target.checked ? [...ids, entry.id] : ids.filter((id) => id !== entry.id))} />{entry.label}</label>)}</fieldset>
      <label>{t("Proposed improvements")}<textarea className="input" value={proposal} onChange={(event) => setProposal(event.target.value)} /></label>
      <button className="btn" disabled={busy || selected.length === 0}>{t("Retain retrospective scope")}</button>
    </form>
    {detail.retrospectives.map((retro) => <article className="factory-message" key={retro.id}><p>{retro.proposal || t("Evidence selected for retrospective")}</p><small>{retro.scope_hash}</small>
      <div className="factory-actions"><button className="btn" disabled={busy} onClick={() => void start(retro, "retro")}>{t("Run retrospective")}</button>
        <button className="btn" disabled={busy || retro.approved || !retro.proposal} onClick={() => void perform(async () => { await factoryRequest(`/retrospectives/${retro.id}/approve`, { scope_hash: retro.scope_hash }); })}>{t("Approve proposed improvements")}</button>
        <button className="btn" disabled={busy || !retro.approved} onClick={() => void start(retro, "apply-retro")}>{t("Apply in a new worktree")}</button>
      </div>
    </article>)}
  </section>;
}
