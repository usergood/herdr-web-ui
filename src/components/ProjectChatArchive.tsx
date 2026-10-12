import { useEffect, useRef, useState } from "react";
import { Archive, ArchiveRestore } from "lucide-react";
import { factoryRequest } from "../lib/factoryApi.ts";
import { useT } from "../lib/i18n.ts";

export function ProjectChatArchive({ machineId, paneId, terminalId, sessionRef, archived, onArchived }: { machineId: string; paneId: string; terminalId: string; sessionRef: string | null; archived: boolean; onArchived: () => void }) {
  const t = useT(); const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  async function archive() {
    if (busy) return; setBusy(true); setError(null);
    try { await factoryRequest("/pane-archives", { machine_id: machineId, pane_id: paneId, terminal_id: terminalId, session_ref: sessionRef, archived: !archived }); if (live.current && !archived) onArchived(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  return <><button className="icon-button" disabled={busy} aria-label={archived ? t("Restore chat") : t("Archive chat")} title={archived ? t("Restore chat") : t("Archive chat")} onClick={() => void archive()}>{archived ? <ArchiveRestore /> : <Archive />}</button>{error && <span role="alert">{error}</span>}</>;
}
