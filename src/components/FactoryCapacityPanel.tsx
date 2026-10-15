import type { FactoryCapacity } from "../../shared/factory.ts";
import { useT } from "../lib/i18n.ts";
import "./FactoryCapacityPanel.css";

export function FactoryCapacityPanel({ capacity }: { capacity: FactoryCapacity }) {
  const t = useT();
  return <section className="factory-capacity" aria-label={t("Factory capacity")}>
    <div className="factory-capacity-counts" role="status">
      <span>{t("Agent contexts: {used}/{limit}", capacity.normal)}</span>
      <span>{t("Extra planning context: {used}/{limit}", capacity.planning)}</span>
      <span>{t("Builds: {used}/{limit}", capacity.builds)}</span>
    </div>
    <p className="field-hint">{t("One extra context is shared by interviews and pre-approval Specification drafting. Implementation, review and repair use normal capacity.")}</p>
    <p className="field-hint">{t("Only app-managed agents count. Ordinary terminals and independently launched agents are excluded.")} {t("Viewing and approval use no agent capacity.")}</p>
    <ul className="factory-capacity-reservations">
      {capacity.contexts.map(context => <li key={context.id}>
        <strong>{context.assignment_title}</strong> · {context.label} · {context.machine_id} · {context.provider} · {context.condition} · {context.pool === "planning" ? t("Extra planning capacity") : t("Normal capacity")}
        {context.uncertain && <p className="factory-capacity-uncertain">{t("Execution uncertain; reservation retained")}</p>}
        {context.reason && <p>{context.reason}</p>}
      </li>)}
      {capacity.build_reservations.map(build => <li key={build.id}>
        <strong>{build.assignment_title}</strong> · {t("Build limit")} · {build.machine_id} · {build.condition}
        {build.uncertain && <p className="factory-capacity-uncertain">{t("Execution uncertain; reservation retained")}</p>}
      </li>)}
      {capacity.waiting.map(wait => <li key={wait.id}>
        <a href={`#factory/${wait.implementation_id}`}>{wait.assignment_title}</a> · {t("Waiting for agent capacity")} · {wait.machine_id} · {wait.provider}
      </li>)}
    </ul>
    {!capacity.contexts.length && !capacity.build_reservations.length && !capacity.waiting.length && <p className="field-hint">{t("No occupied reservations.")}</p>}
  </section>;
}
