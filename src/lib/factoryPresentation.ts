import type { FactoryAutomaticExecution, FactoryCheck, FactoryReviewEvidence, FactoryWorker } from "../../shared/factory.ts";
import type { RunCondition } from "../../shared/protocol.ts";
import { t } from "./i18n.ts";
import type { Translate } from "./i18n.ts";

export function factoryConditionLabel(condition: RunCondition, t: Translate): string {
  switch (condition) {
    case "accepted": case "working": return t("Running");
    case "ready": return t("Ready");
    case "needs_you": case "blocked": return t("Needs you");
    case "disconnected": return t("Disconnected");
    case "interrupted": return t("Interrupted");
    case "failed": return t("Failed");
    case "cancelled": return t("Stopped attempt");
    case "completed": return t("Finished attempt");
  }
}

/** Failure reasons are assertive; ordinary execution and owner waits stay polite. */
export function factoryReasonRole(condition: string | null | undefined): "alert" | "status" {
  return condition === "uncertain" || condition === "blocked" || condition === "failed" || condition === "disconnected" || condition === "interrupted" ? "alert" : "status";
}

export function factoryExecutionConditionLabel(condition: FactoryAutomaticExecution["condition"]): string {
  switch (condition) {
    case "executing": return t("Implementing");
    case "waiting": return t("Waiting");
    case "blocked": return t("Blocked");
    case "checked": return t("Checks passed");
  }
}

export function factoryWorkerRoleLabel(role: FactoryWorker["role"]): string {
  switch (role) {
    case "implementer": return t("Implementer");
    case "standards": return t("Standards");
    case "spec": return t("Spec");
  }
}

export function factoryReportOutcomeLabel(outcome: FactoryReviewEvidence["outcome"]): string {
  switch (outcome) {
    case "passed": return t("Passed");
    case "failed": return t("Failed");
  }
}

export function factoryCheckConditionLabel(condition: FactoryCheck["condition"]): string {
  switch (condition) {
    case "working": return t("Testing");
    case "passed": case "failed": return factoryReportOutcomeLabel(condition);
    case "interrupted": return t("Interrupted");
    case "cancelled": return t("Stopped attempt");
  }
}

/** Reservation snapshots can include an unfamiliar native condition; never expose its wire token. */
export function factoryReservationConditionLabel(condition: string): string {
  switch (condition) {
    case "accepted": case "working": case "ready": case "needs_you": case "blocked":
    case "disconnected": case "interrupted": case "failed": case "cancelled": case "completed":
      return factoryConditionLabel(condition, t);
    default: return t("Uncertain");
  }
}
