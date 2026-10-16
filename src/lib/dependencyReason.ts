import type { useT } from "./i18n.ts";

export function dependencyReason(code: string | null, t: ReturnType<typeof useT>): string | null {
  switch (code) {
    case "delivery_unverified": return t("Delivery has not been verified.");
    case "wrong_target": return t("Intended PRs must merge into the target branch.");
    case "release_unverified": return t("A containing release has not been verified.");
    case null: return t("Verified dependency delivery.");
    case "cross_boundary": return t("Dependency crosses a Project or repository boundary. Resolve it before starting work.");
    case "cyclic": return t("Dependency cycle. Correct the declared relationships.");
    case "ambiguous": return t("Dependency identity is ambiguous. Inspect the declared relationships.");
    case "missing": return t("Dependency is missing or inaccessible in this Project. Check access and sync GitHub.");
    default: return null;
  }
}
