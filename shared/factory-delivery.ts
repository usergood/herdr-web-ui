import type { AccountBindingSnapshot } from "./accounts.ts";

/** Read-only, bounded GitHub resources for delivery evidence on the selected Machine. */
export interface DeliveryReadRequest {
  account_snapshot: AccountBindingSnapshot; repository: string;
  kind: "repository" | "branch" | "pull" | "files" | "tree" | "compare";
  number?: number; page?: number; ref?: string; base?: string; head?: string;
}
