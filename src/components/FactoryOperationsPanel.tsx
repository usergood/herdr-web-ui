import { useState } from "react";
import type { FactoryOverview, FactoryProvider } from "../../shared/protocol.ts";
import { factoryRequest } from "../lib/factoryApi.ts";
import { useT } from "../lib/i18n.ts";

interface Backup { id: string; created_at: string; blob_count?: number }
export function FactoryOperationsPanel({ overview, busy, perform }: { overview: FactoryOverview; busy: boolean; perform: (action: () => Promise<void>) => Promise<void> }) {
  const t = useT(); const [backups, setBackups] = useState<Backup[]>([]); const [restored, setRestored] = useState("");
  const [provider, setProvider] = useState<FactoryProvider>(overview.settings.provider);
  const [implementations, setImplementations] = useState(overview.settings.max_implementations);
  const [agents, setAgents] = useState(overview.settings.max_agents); const [builds, setBuilds] = useState(overview.settings.max_builds);
  return <details className="factory-section"><summary>{t("Factory settings and recovery")}</summary>
    <form className="factory-form" onSubmit={(event) => { event.preventDefault(); void perform(async () => { await factoryRequest("/settings", { provider, max_implementations: implementations, max_agents: agents, max_builds: builds }); }); }}>
      <label>{t("Provider")}<select className="select" value={provider} onChange={(event) => setProvider(event.target.value as FactoryProvider)}><option>codex</option><option>claude</option><option>opencode</option></select></label>
      <label>{t("Concurrent Implementations")}<input className="input" type="number" min={1} max={3} value={implementations} onChange={(event) => setImplementations(event.target.valueAsNumber)} /></label>
      <label>{t("Native context limit")}<input className="input" type="number" min={1} max={32} value={agents} onChange={(event) => setAgents(event.target.valueAsNumber)} /></label>
      <label>{t("Build limit")}<input className="input" type="number" min={1} max={16} value={builds} onChange={(event) => setBuilds(event.target.valueAsNumber)} /></label>
      <p>{t("Attachment limit")} · {overview.settings.max_artifact_bytes.toLocaleString()} B<br />{t("Retained storage limit")} · {overview.settings.max_storage_bytes.toLocaleString()} B</p>
      <button className="btn" disabled={busy}>{t("Save factory settings")}</button>
    </form>
    <div className="factory-actions"><button className="btn" disabled={busy} onClick={() => void perform(async () => { await factoryRequest("/backups", {}); setBackups(await factoryRequest("/backups")); })}>{t("Create verified backup")}</button><button className="btn" disabled={busy} onClick={() => void perform(async () => { setBackups(await factoryRequest("/backups")); })}>{t("List backups")}</button></div>
    {backups.map((backup) => <p key={backup.id}>{new Date(backup.created_at).toLocaleString()} · {backup.id}<button className="btn" disabled={busy} onClick={() => void perform(async () => { const copy = await factoryRequest<{ state_dir: string }>(`/backups/${backup.id}/restore`, {}); setRestored(copy.state_dir); })}>{t("Restore to an isolated copy")}</button></p>)}
    {restored && <p role="status">{t("Restored copy: execution remains disabled.")} <code>{restored}</code></p>}
  </details>;
}
