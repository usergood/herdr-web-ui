import { useState } from "react";
import { Trash2 } from "lucide-react";
import type { FactoryDeleteResult, Implementation } from "../../shared/factory.ts";
import { factoryRequest } from "../lib/factoryApi.ts";
import { useT } from "../lib/i18n.ts";

export function AssignmentDelete({ assignment, busy, perform, onDeleted }: { assignment: Implementation; busy: boolean; perform: (action: () => Promise<void>) => Promise<void>; onDeleted: () => void }) {
  const t = useT(); const [confirming, setConfirming] = useState(false);
  return <section className="assignment-pause factory-section" aria-label={t("Assignment deletion")}>
    {assignment.deletion ? <>
      <p role="status" className="assignment-pause-status">{t("Delete pending")}</p>
      {assignment.deletion.local_cleanup === "complete" && <p>{t("Local cleanup is complete. Required external cleanup is still pending.")}</p>}
      {assignment.deletion.reasons.map(reason => <p role="alert" key={reason}>{reason}</p>)}
    </> : confirming ? <>
      <p>{t("Permanently delete this Assignment and all its owned work?")}</p>
      <p>{t("This stops execution and removes owned history, dirty worktrees, local branches, linked issues and app-managed recovery data. Shared resources, primary checkouts, pushed branches and PRs are preserved.")}</p>
      <p>{t("Exported copies and external provider history are excluded from Delete.")}</p>
      <div className="factory-actions"><button className="btn factory-button" disabled={busy} onClick={() => void perform(async () => {
        const result = await factoryRequest<FactoryDeleteResult>(`/implementations/${assignment.id}/delete`, {});
        setConfirming(false); if (result.condition === "deleted") onDeleted();
      })}>{t("Delete all owned work")}</button><button className="btn" disabled={busy} onClick={() => setConfirming(false)}>{t("Cancel")}</button></div>
    </> : <button className="btn factory-button" disabled={busy} onClick={() => setConfirming(true)}><Trash2 aria-hidden="true" />{t("Delete Assignment")}</button>}
  </section>;
}
