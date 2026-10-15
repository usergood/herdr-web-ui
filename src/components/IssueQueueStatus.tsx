import type { IssueQueueEntry } from "../../shared/issue-queue.ts";
import type { ReadinessBlocker } from "../../shared/github-readiness.ts";
import { useT } from "../lib/i18n.ts";
import { readinessReason } from "./IssueReadiness.tsx";

export function IssueQueueStatus({ entry, showReasons = true }: { entry: IssueQueueEntry; showReasons?: boolean }) {
  const t = useT();
  function reason(code: string): string {
    if (code.startsWith("readiness_")) return readinessReason(code.slice(10) as ReadinessBlocker, t);
    switch (code) {
      case "planning_required": return t("Prepare the trusted issue plan before implementation.");
      case "planning_needs_you": return t("Resolve the selected plan's outstanding decisions.");
      case "planning_changed": return t("Planning changed. Review the current scope and readiness.");
      case "dependencies_stale": return t("Dependency evidence is stale or incomplete. Sync GitHub before starting work.");
      case "dependencies_conflict": return t("Approved plan dependencies are unresolved. Declare a JSON array with repository, issue number and merge or release requirements, or None.");
      case "dependency_delivery_unverified": return t("Delivery has not been verified.");
      case "dependency_release_unverified": return t("A containing release has not been verified.");
      case "dependency_wrong_target": return t("Intended PRs must merge into the target branch.");
      case "dependency_cross_boundary": return t("Dependency crosses a Project or repository boundary. Resolve it before starting work.");
      case "dependency_cyclic": return t("Dependency cycle. Correct the declared relationships.");
      case "dependency_ambiguous": return t("Dependency identity is ambiguous. Inspect the declared relationships.");
      case "dependency_missing": return t("Dependency is missing or inaccessible in this Project. Check access and sync GitHub.");
      case "account_unavailable": return t("Verify the selected GitHub and readiness accounts.");
      case "assignment_moved": return t("Return this Assignment to its original Project before intake.");
      case "assignment_archived": return t("Archived Assignments are excluded from intake.");
      case "assignment_finished": return t("This Assignment already has an implementation outcome.");
      case "attempt_exists": return t("This Assignment already has an execution attempt. Review it before retrying.");
      default: return t("Review the issue before implementation.");
    }
  }
  return <div role="status">
    <p>{entry.lane === "needs_you" ? t("Needs you") : entry.lane === "queued" ? t("Queued") : t("Inbox")} · {entry.eligible ? t("Eligible") : t("Ineligible")}</p>
    {showReasons && !!entry.reasons.length && <ul>{entry.reasons.map((item, index) => <li key={`${item.code}:${index}`}>{reason(item.code)}{item.detail && <span> · {item.detail}</span>}</li>)}</ul>}
  </div>;
}
