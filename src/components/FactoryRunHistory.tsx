import type { FactoryRun } from "../../shared/protocol.ts";
import { factoryRunActivity } from "../../shared/factory-board.ts";
import { factoryConditionLabel } from "../lib/factoryPresentation.ts";
import { useT } from "../lib/i18n.ts";
import { FactoryBoardStatus } from "./FactoryBoardStatus.tsx";

export function FactoryRunHistory({ runs }: { runs: FactoryRun[] }) {
  const t = useT();
  if (!runs.length) return null;
  return <section className="factory-section" aria-label={t("Past attempts")}>
    <h3>{t("Past attempts")}</h3>
    {runs.map(run => <article className="factory-message" key={run.id}>
      <p>{factoryConditionLabel(run.condition, t)} · <time dateTime={run.created_at}>{new Date(run.created_at).toLocaleString()}</time> · {run.provider}</p>
      <FactoryBoardStatus state={{ implementation_id: run.implementation_id, lane: "done", activity: factoryRunActivity(run.action), condition: run.condition, run_id: run.id, busy: false, waiting_reason: run.waiting_reason, delivery_completion_error: run.delivery_completion_error, ticket_progress: null }} />
    </article>)}
  </section>;
}
