import type { FactoryRecord } from "./factory.ts";
import type { ProjectIssuePlan } from "./github-project.ts";

/** Each item is one independently deliverable Assignment/PR; internal work stays Tickets. */
export interface PlannedIssue {
  key: string; title: string; body: string; deliverable: string; ready_for_agent: boolean;
  dependencies: { key: string; requires: "merge" | "release" }[]; plan: ProjectIssuePlan;
}
export interface IssueBatchProposal {
  title: string; items: PlannedIssue[]; idempotency_key: string;
  batch_id?: string; expected_revision: string | null; run_id?: string;
}
export interface IssueBatch extends FactoryRecord {
  implementation_id: string; project_id: string; run_id: string | null;
  title: string; items: PlannedIssue[]; key: string; revision: string;
  condition: "proposed" | "reviewed" | "publishing" | "held" | "confirmed"; dispatch_ready: boolean;
  review: { revision: string; policy_revision: string; repository: string; account_profile_id: string; project_scope: string; reviewed_at: string; plan_url: string } | null;
  issues: { key: string; number: number; external_id: string; url: string; implementation_id: string; links_confirmed: boolean }[];
  intents: (FactoryRecord & { item_key: string; action: "create" | "link" | "label"; condition: "sending" | "confirmed" | "uncertain"; issue_number: number | null; problem: string | null })[];
  problem: string | null;
}
export interface IssueBatchesOverview { batches: IssueBatch[] }
export interface IssueBatchAction { revision: string; policy_revision: string }
