import type { FactoryRun } from "./factory.ts";

/** Planning and verification history never supersede an implementation attempt. */
export function latestImplementationAttempt(runs: readonly FactoryRun[]): FactoryRun | undefined {
  return runs.filter(run => run.action === "implement-spec").at(-1);
}

/** A resting planning step or its verification prerequisite may hand off ownership.
 * Native provider proof is still required separately by implementation admission. */
export function readyIssuePlanningStep(run: FactoryRun | null | undefined): boolean {
  return !!run && run.condition === "ready" && !run.issue_pause && ["grill-me", "grill-with-docs", "to-spec", "to-tickets", "verify-provider"].includes(run.action);
}

/** Automatic starts require explicit opt-in bound to a reviewed backlog. */
export interface ProjectQueuePolicy {
  project_id: string; revision: string | null; automatic_implementation: boolean;
  paused: boolean; max_implementations: number;
}
export interface QueueConfiguration {
  expected_revision: string | null; automatic_implementation: boolean;
  preview_revision?: string;
  paused: boolean; max_implementations: number;
}
export interface IssueQueueEntry {
  source_id: string; implementation_id: string; number: number; title: string; position: number;
  eligible: boolean; lane: "inbox" | "queued" | "needs_you" | "running" | "review" | "done";
  activity?: "awaiting_merge";
  reasons: { code: string; detail: string }[];
}
export interface IssueQueue {
  dispatch_problem?: { code: string; message: string; source_id: string | null } | null;
  implementing_count: number; available_slots: number;
  policy: ProjectQueuePolicy; global_limit: number; effective_limit: number; revision: string;
  eligible_count: number; entries: IssueQueueEntry[];
  preview: { revision: string; created_at: string; eligible_count: number } | null;
  preview_current: boolean;
}
