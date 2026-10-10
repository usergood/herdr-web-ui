/** Durable factory records. IDs belong to the application; native pane IDs are provenance. */
import type { ConversationTurn } from "./protocol.ts";
export type FactoryProvider = "codex" | "claude" | "opencode";
export type FactoryStage = "inbox" | "specifying" | "ready" | "running" | "review" | "done";
export type RunCondition = "accepted" | "working" | "needs_you" | "blocked" | "disconnected" | "interrupted" | "failed" | "cancelled" | "completed";
export type FactoryAction = "setup" | "grill-me" | "grill-with-docs" | "to-spec" | "to-tickets" | "implement-spec" | "retro" | "apply-retro" | "verify-provider";
export interface FactoryRecord { id: string; created_at: string; updated_at: string }
export interface Implementation extends FactoryRecord {
  title: string; description: string; project_id: string | null; provider: FactoryProvider | null;
  machine_id: string | null; stage: FactoryStage; position: number;
  outcome: "none" | "implementation_complete" | "pr_open" | "merged" | "released";
}
export interface FactoryProject extends FactoryRecord {
  name: string; repository: string; provider: FactoryProvider; machine_id: string;
  tracker: "app" | "github" | "gitlab" | "local"; tracker_reference: string;
  checks?: string[][]; setup?: string[][]; environment?: Record<string, string>;
  permissions?: string; shared_paths?: string[];
}
export interface ProjectCheckout extends FactoryRecord {
  project_id: string; machine_id: string; path: string; repository: string; head: string;
  branch: string; instructions: { path: string; hash: string; content: string }[];
}
export interface FactoryChat extends FactoryRecord { implementation_id: string; title: string }
export interface FactoryMessage extends FactoryRecord {
  implementation_id: string; chat_id: string; role: "owner" | "agent" | "system";
  content: string; source_id: string | null; sequence: number | null;
}
export interface FactoryEvent extends FactoryRecord { implementation_id: string | null; kind: string; data: unknown }
export interface SpecificationVersion extends FactoryRecord { implementation_id: string; revision: number; content: string; hash: string }
export interface FactoryTicket extends FactoryRecord {
  implementation_id: string; specification_id: string; title: string; acceptance: string;
  dependencies: string[]; status: "proposed" | "ready" | "working" | "review" | "done";
  tracker_reference: string | null;
}
export interface FactoryApproval extends FactoryRecord { implementation_id: string; kind: "specification" | "testing_seams" | "ticket_graph" | "review" | "shared_understanding"; revision: string; scope: string }
export interface FactoryQuestion extends FactoryRecord { implementation_id: string; run_id: string | null; question: string; answer: string | null; revision: string }
export interface FactoryArtifact extends FactoryRecord {
  implementation_id: string; chat_id: string; name: string; media_type: string;
  hash: string; size: number; version: number; origin: string; note: string;
}
export interface FactoryRun extends FactoryRecord {
  implementation_id: string; action: FactoryAction; provider: FactoryProvider; machine_id: string;
  condition: RunCondition; waiting_reason: string | null; idempotency_key: string;
  specification_id: string | null; graph_hash: string | null; base: string | null;
  checkout: string | null; worktree: string | null; branch: string | null;
  workspace_id: string | null; pane_id: string | null; manifest: unknown;
}
export interface ReviewSnapshot extends FactoryRecord {
  implementation_id: string; run_id: string | null; machine_id: string; repository: string;
  mode: "branch" | "workspace"; base: string; head: string; hash: string;
  files: { path: string; status: string; diff: string; binary: boolean; oversized: boolean }[];
}
export interface ReviewComment extends FactoryRecord {
  implementation_id: string; run_id: string | null; snapshot_id: string; path: string; change: string;
  side: "old" | "new"; line_start: number; line_end: number; context: string;
  content: string; status: "draft" | "submitted" | "outdated" | "resolved";
  batch_id: string | null;
  resolution?: { head: string; check_id: string; summary: string };
}
export interface FactorySettings {
  provider: FactoryProvider; max_implementations: number; max_agents: number; max_builds: number;
  max_artifact_bytes: number; max_storage_bytes: number; skills_path: string | null;
}
export interface FactoryDetail {
  graph_hash: string; question_revision: string;
  implementation: Implementation; chats: FactoryChat[]; messages: FactoryMessage[];
  specifications: SpecificationVersion[]; tickets: FactoryTicket[]; approvals: FactoryApproval[];
  questions: FactoryQuestion[]; artifacts: FactoryArtifact[]; runs: FactoryRun[];
  snapshots: ReviewSnapshot[]; comments: ReviewComment[]; events: FactoryEvent[];
  workers: FactoryWorker[]; checks: FactoryCheck[]; review_evidence: FactoryReviewEvidence[];
  frontier: FactoryTicket[];
  retrospectives: FactoryRetrospective[];
  native_snapshots: NativeConversationSnapshot[];
}
export interface FactoryOverview { implementations: Implementation[]; projects: FactoryProject[]; checkouts: ProjectCheckout[]; settings: FactorySettings; activity: { implementation_id: string; run_id: string; condition: RunCondition; action: FactoryAction; waiting_reason: string | null; completed_tickets: number; total_tickets: number }[] }
export interface FactoryProviderCapability { provider: FactoryProvider; version: string | null; installed: boolean; skills_verified: boolean; factory_ready: boolean; reasons: string[] }
export interface FactoryCapabilities { providers: FactoryProviderCapability[]; skill_manifest: { commit: string; hash: string; file_count: number } | null; factory_host_protocol: 1 }
export interface FactoryOutput { name: string; media_type: string; hash: string; size: number }
export interface FactoryWorker extends FactoryRecord {
  run_id: string; ticket_id: string; role: "implementer" | "standards" | "spec";
  condition: RunCondition; base: string; head: string | null; integration_tip: string;
  worktree: string | null; branch: string | null; workspace_id: string | null; pane_id: string | null;
  shared_paths: string[]; waiting_reason: string | null;
  rework_batch_id: string | null;
}
export interface FactoryCheck extends FactoryRecord {
  run_id: string; worker_id: string | null; head: string; workspace_hash: string;
  commands: { args: string[]; exit_code: number; output: string }[];
  condition: "working" | "passed" | "failed" | "interrupted";
}
export interface FactoryReviewEvidence extends FactoryRecord {
  run_id: string; worker_id: string; axis: "standards" | "spec"; head: string;
  source_id: string; content: string; outcome: "passed" | "failed";
}
export interface FactoryRetrospective extends FactoryRecord {
  project_id: string; evidence_ids: string[]; scope_hash: string;
  proposal: string; approved: boolean; applied_run_id: string | null;
}
export interface NativeConversationSnapshot extends FactoryRecord {
  run_id: string; source_id: string; sequence: number; version: string;
  turns: ConversationTurn[]; cursor: string | null;
}
