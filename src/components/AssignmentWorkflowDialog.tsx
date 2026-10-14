import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { FactoryDetail, FactoryOverview } from "../../shared/factory.ts";
import type { Machine } from "../../shared/machines.ts";
import type { AgentModelSelection } from "../../shared/agent-models.ts";
import { factoryDetail } from "../lib/factoryApi.ts";
import { useFactoryCapabilities } from "../lib/useFactoryCapabilities.ts";
import { useT } from "../lib/i18n.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { AssignmentActions } from "./AssignmentActions.tsx";
import "./AssignmentWorkflowDialog.css";

/** Decisions and continuation stay available over the selected native chat. */
export function AssignmentWorkflowDialog({ assignmentId, overview, machines, onClose, onOpenPane, keyboardActive = true }: { assignmentId: string; overview: FactoryOverview; machines: Machine[]; onClose: () => void; onOpenPane: (machineId: string, paneId: string) => void; keyboardActive?: boolean }) {
  const t = useT(); const surface = useFocusTrap<HTMLElement>(true);
  const [detail, setDetail] = useState<FactoryDetail | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const [preset, setPreset] = useState<AgentModelSelection>({ model: null, reasoning: null });
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    const next = await factoryDetail(assignmentId);
    if (request === generation.current) setDetail(next);
  }, [assignmentId]);
  const project = overview.projects.find(p => p.id === detail?.implementation.project_id);
  const provider = detail?.implementation.provider ?? project?.provider ?? overview.settings.provider;
  const machineId = detail?.implementation.machine_id ?? project?.machine_id ?? "local";
  const capabilities = useFactoryCapabilities(machineId, detail?.implementation.id ?? null, JSON.stringify(project?.account_bindings?.[machineId] ?? {}));
  useSheetSwipe(surface, busy || !keyboardActive ? null : onClose);
  useEffect(() => { setPreset(project?.execution_preset ?? { model: null, reasoning: null }); }, [project?.id, project?.execution_preset?.model, project?.execution_preset?.reasoning]);
  useEffect(() => {
    let live = true; let timer: ReturnType<typeof setTimeout>;
    const read = async () => { try { if (!busy && document.visibilityState === "visible") await refresh(); } catch (failure) { if (live) setError(failure instanceof Error ? failure.message : String(failure)); } finally { if (live) timer = setTimeout(() => void read(), 3000); } };
    void read(); return () => { live = false; generation.current++; clearTimeout(timer); };
  }, [refresh, busy]);
  useEffect(() => {
    if (!keyboardActive) return;
    const escape = (event: KeyboardEvent) => { if (busy || event.key !== "Escape" || event.isComposing || nativeModalOver(surface.current)) return; event.preventDefault(); event.stopPropagation(); onClose(); };
    window.addEventListener("keydown", escape); return () => window.removeEventListener("keydown", escape);
  }, [onClose, busy, keyboardActive]);
  async function perform(action: () => Promise<void>) {
    if (busy) return; setBusy(true); setError(null);
    try { await action(); await refresh(); } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); await refresh().catch(() => {}); } finally { setBusy(false); }
  }
  return <div className="modal-scrim" onMouseDown={event => !busy && event.target === event.currentTarget && onClose()}>
    <section ref={surface} className="modal assignment-workflow-dialog" role="dialog" aria-modal="true" aria-label={t("Workflow")} tabIndex={-1}>
      <header className="modal-header"><h2 className="modal-title">{detail?.implementation.title ?? t("Workflow")}</h2><button className="icon-button" aria-label={t("Close")} disabled={busy} onClick={onClose}><X /></button></header>
      <div className="assignment-workflow-body">
        {error && <p role="alert">{error}</p>}
        {!detail && <p role="status">{t("Loading…")}</p>}
        {detail && <AssignmentActions key={detail.implementation.id} detail={detail} project={project} provider={provider} machineId={machineId} machineName={machines.find(machine => machine.id === machineId)?.name ?? machineId} preset={preset} onPresetChange={setPreset} busy={busy} perform={perform} capabilities={capabilities.capabilities} problem={capabilities.problem} onCapabilities={capabilities.apply} onOpenPane={(machine, pane) => { onOpenPane(machine, pane); onClose(); }} />}
      </div>
    </section>
  </div>;
}
