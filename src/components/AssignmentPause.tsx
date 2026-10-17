import type { Implementation } from "../../shared/protocol.ts";
import { factoryRequest } from "../lib/factoryApi.ts";
import { useT } from "../lib/i18n.ts";
import "./AssignmentPause.css";

export function AssignmentPause({ assignment, busy, perform }: { assignment: Implementation; busy: boolean; perform: (action: () => Promise<void>) => Promise<void> }) {
  const t = useT();
  const pause = assignment.pause;
  if (assignment.deletion) return null;
  return <section className="assignment-pause factory-section" aria-label={t("Assignment execution")}>
    {pause && <p role="status" className="assignment-pause-status">{pause.condition === "pending" ? t("Pause pending") : t("Paused")}</p>}
    {pause?.reasons.map(reason => <p role="alert" key={reason}>{reason}</p>)}
    <button className="btn factory-button" disabled={busy || !!assignment.deletion || pause?.condition === "pending"} onClick={() => void perform(async () => { await factoryRequest(`/implementations/${assignment.id}/${pause ? "resume" : "pause"}`, {}); })}>
      {pause ? t("Resume Assignment") : t("Pause Assignment")}
    </button>
  </section>;
}
