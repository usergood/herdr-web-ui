import type { RunCondition } from "../../shared/protocol.ts";
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
