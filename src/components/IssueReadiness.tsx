import type { IssueReadiness as Readiness, ReadinessBlocker } from "../../shared/github-readiness.ts";
import { useT } from "../lib/i18n.ts";

export function IssueReadiness({ readiness }: { readiness?: Readiness }) {
  const t = useT();
  function reason(code: ReadinessBlocker): string {
    switch (code) {
      case "identity_required": return t("Select your readiness account in Project GitHub settings.");
      case "mapping_conflict": return t("Give every triage role and the blocked signal a different label.");
      case "role_not_ready": return t("Apply the Project's ready-for-agent label after planning is complete.");
      case "triage_conflict": return t("Remove conflicting triage labels.");
      case "blocked": return t("Resolve the issue's blocked signal before implementation.");
      case "closed": return t("Closed issues are ineligible; closure does not prove delivery.");
      case "evidence_missing": return t("Reapply the ready label after reviewing this scope, or approve this revision here.");
      case "evidence_incomplete": return t("Sync GitHub to collect complete readiness evidence.");
      case "untrusted": return t("The ready label was applied by an untrusted identity. Renew trusted readiness or approve this revision here.");
      case "stale": return t("The scope changed after readiness. Review it and renew trusted readiness or approve this revision here.");
      case "sync_required": return t("Sync GitHub before using readiness for this scope.");
      case "policy_changed": return t("The Project scope changed. Save readiness settings and sync again.");
    }
  }
  return <div role="status">
    <p>{readiness?.eligible ? t("Current issue scope has trusted readiness.") : t("Issue readiness is blocked.")}</p>
    {readiness && <ul>{readiness.blockers.map(code => <li key={code}>{reason(code)}</li>)}</ul>}
    {readiness?.approval && <p>{t("Approved by {login}", { login: readiness.approval.actor.login })} · {readiness.approval.provenance === "app_owner" ? t("Owner approval in app") : t("Trusted GitHub label")} · {new Date(readiness.approval.approved_at).toLocaleString()}</p>}
  </div>;
}
