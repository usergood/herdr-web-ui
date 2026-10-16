import { useEffect, useState } from "react";
import type { AgentModelCatalog, AgentModelSelection } from "../../shared/agent-models.ts";
import type { FactoryProvider } from "../../shared/factory.ts";
import { factoryRequest } from "../lib/factoryApi.ts";
import { useT } from "../lib/i18n.ts";

export function AgentModelPicker({ projectId, machineId, provider, accountScope = "", value, onChange, disabled = false }: { projectId: string; machineId: string; provider: FactoryProvider; accountScope?: string; value: AgentModelSelection; onChange: (selection: AgentModelSelection) => void; disabled?: boolean }) {
  const t = useT(); const [revision, setRevision] = useState(0);
  const [catalog, setCatalog] = useState<AgentModelCatalog | null>(null);
  const [loading, setLoading] = useState(true); const [problem, setProblem] = useState(false);
  useEffect(() => {
    let live = true; setCatalog(null); setLoading(true); setProblem(false);
    void factoryRequest<AgentModelCatalog>("/model-catalog", { project_id: projectId, machine_id: machineId, provider }).then(result => {
      if (live) { setCatalog(result); setProblem(!!result.problem); }
    }, () => { if (live) setProblem(true); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [projectId, machineId, provider, accountScope, revision]);
  const model = catalog?.models.find(entry => entry.id === value.model);
  return <div className="factory-form" aria-label={t("Agent model settings")}>
    <label>{t("Model")}<select className="select factory-input" aria-label={t("Model")} value={value.model ?? ""} disabled={disabled || loading} onChange={event => onChange({ model: event.target.value || null, reasoning: null })}>
      <option value="">{t("Use CLI default")}</option>
      {value.model && !model && <option value={value.model} disabled>{value.model} · {t("Unavailable")}</option>}
      {catalog?.models.map(entry => <option key={entry.id} value={entry.id}>{entry.name} · {entry.id}</option>)}
    </select></label>
    <label>{t("Reasoning level")}<select className="select factory-input" aria-label={t("Reasoning level")} value={value.reasoning ?? ""} disabled={disabled || loading || !model || !model.reasoning.length} onChange={event => onChange({ ...value, reasoning: event.target.value || null })}>
      <option value="">{t("Use model default")}{model?.default_reasoning ? ` · ${model.default_reasoning}` : ""}</option>
      {value.reasoning && !model?.reasoning.some(entry => entry.id === value.reasoning) && <option value={value.reasoning} disabled>{value.reasoning} · {t("Unavailable")}</option>}
      {model?.reasoning.map(entry => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
    </select></label>
    {loading && <p role="status">{t("Loading models…")}</p>}
    {problem && <p role="alert">{t("Model catalog unavailable. Use CLI defaults or refresh after signing in.")}</p>}
    <button type="button" className="btn factory-button" disabled={disabled || loading} onClick={() => setRevision(previous => previous + 1)}>{t("Refresh model list")}</button>
  </div>;
}
