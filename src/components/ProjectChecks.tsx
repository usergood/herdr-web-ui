import type { ProjectCheckChoice } from "../../shared/project-setup.ts";
import { useT } from "../lib/i18n.ts";
import "./ProjectChecks.css";

export function ProjectChecks({ choices, selected, onChange }: { choices: ProjectCheckChoice[]; selected: string[]; onChange: (ids: string[]) => void }) {
  const t = useT();
  return <><h3>{t("Repository checks")}</h3>{choices.map(check => <label className="project-check-choice" key={check.id}>
    <input type="checkbox" aria-label={check.name} checked={selected.includes(check.id)} onChange={event => onChange(event.target.checked ? [...selected, check.id] : selected.filter(id => id !== check.id))} />
    <span>{check.name}</span><code>{check.args.join(" ")}</code>
  </label>)}{!choices.length && <p role="status">{t("No checks detected. You can save setup; add checks before implementation.")}</p>}</>;
}
