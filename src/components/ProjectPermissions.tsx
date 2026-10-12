import type { AgentPermissionMode } from "../../shared/agent-permissions.ts";
import { useT } from "../lib/i18n.ts";

export function permissionLabel(mode: AgentPermissionMode, t: ReturnType<typeof useT>): string {
  switch (mode) { case "approve_for_me": return t("Approve for me"); case "accept_edits": return t("Accept file edits"); case "auto": return t("Automatic permission review"); case "allow": return t("Allow tool use"); case "read_only": return t("Read-only planning"); default: return t("Ask for approval"); }
}
export function ProjectPermissions({ value, modes, onChange, disabled = false }: { value: AgentPermissionMode; modes: readonly AgentPermissionMode[]; onChange: (mode: AgentPermissionMode) => void; disabled?: boolean }) {
  const t = useT();
  return <label>{t("Execution permissions")}<select className="select" aria-label={t("Execution permissions")} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value as AgentPermissionMode)}>{[...new Set([value, ...modes])].map((mode) => <option key={mode} value={mode} disabled={!modes.includes(mode)}>{permissionLabel(mode, t)}</option>)}</select><span className="field-hint">{t("Uses this agent's native permission mode. Reviewers keep read-only access.")}</span></label>;
}
