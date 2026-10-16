import { factoryReasonRole } from "../lib/factoryPresentation.ts";
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
        {context.reason && <p role={factoryReasonRole(context.condition)}>{context.reason}</p>}
      </li>)}
      {capacity.build_reservations.map(build => <li key={build.id}>
        <strong>{build.assignment_title}</strong> · {t("Build limit")} · {build.machine_id} · {build.condition}
        {build.uncertain && <p className="factory-capacity-uncertain">{t("Execution uncertain; reservation retained")}</p>}
      </li>)}
      {capacity.waiting.map(wait => <li key={wait.id}>
        <a href={`#factory/${wait.implementation_id}`}>{wait.assignment_title}</a> · {wait.condition === "blocked" ? t("Needs you") : t("Waiting for agent capacity")} · {wait.machine_id} · {wait.provider}
        <p role={wait.condition === "blocked" ? "alert" : "status"}>{wait.reason}</p>
      </li>)}
    </ul>
    {!!capacity.continuations?.length && <section aria-label={t("Waiting conversations")}>
      <h4>{t("Waiting conversations")}</h4>
      <p className="field-hint">{t("Waiting conversations retain their history and worktree. Resumption uses the same capacity queue.")}</p>
      <ul className="factory-capacity-reservations">{capacity.continuations.map(context => <li key={context.id}>
        <a href={`#factory/${context.implementation_id}`}>{context.assignment_title}</a> · {context.machine_id} · {context.provider}
        <div role={context.condition === "blocked" ? "alert" : undefined}>
        <p role={context.condition === "blocked" ? undefined : "status"}>{context.condition === "parked" ? t("Execution capacity released") : context.condition === "queued" ? t("Waiting to resume") : context.condition === "sending" ? t("Resuming conversation") : context.condition === "uncertain" ? t("Execution uncertain; reservation retained") : context.condition === "blocked" ? t("Needs you") : t("Waiting for native rest")}</p>
        {context.reason && <p>{context.reason}</p>}
        </div>
      </li>)}</ul>
    </section>}
    {!capacity.contexts.length && !capacity.build_reservations.length && !capacity.waiting.length && <p className="field-hint">{t("No occupied reservations.")}</p>}
  </section>;
}
