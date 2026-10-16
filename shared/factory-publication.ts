import type { AccountBindingSnapshot } from "./accounts.ts";
import type { FactoryRecord } from "./factory.ts";

export interface ImplementationPublication extends FactoryRecord {
  run_id: string; implementation_id: string; machine_id: string; repository: string;
  target_branch: string; branch: string; head: string; base: string; diff_hash: string;
  account_snapshot: AccountBindingSnapshot; check_id: string; review_ids: string[];
  authority: "owner" | "project"; condition: "sending" | "uncertain" | "prepared" | "confirmed";
  /** Written before dispatch, so a missing PR receipt cannot authorize replay. */
  creation_attempted?: boolean;
  upload_head?: string;
  metadata?: { title: string; body: string };
  pull: { number: number; url: string } | null; problem: string | null;
}
export interface PublicationOverview {
  run_id: string; head: string | null; repository: string | null; branch: string | null;
  target_branch: string | null; eligible: boolean; problem: string | null;
  publication: ImplementationPublication | null;
}
export interface PublicationHostRequest {
  action: "lookup" | "branch" | "push" | "create"; publication: ImplementationPublication; title: string;
}
