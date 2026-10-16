/** Durable factory records. IDs belong to the application; native pane IDs are provenance. */
import type { ConversationTurn } from "./protocol.ts";
import type { ProjectAccountBindings } from "./accounts.ts";
export type FactoryProvider = "codex" | "claude" | "opencode";
export type FactoryStage = "inbox" | "specifying" | "ready" | "running" | "review" | "done";
export type RunCondition = "accepted" | "working" | "ready" | "needs_you" | "blocked" | "disconnected" | "interrupted" | "failed" | "cancelled" | "completed";
export type FactoryAction = "work" | "setup" | "grill-me" | "grill-with-docs" | "to-spec" | "to-tickets" | "implement-spec" | "retro" | "apply-retro" | "verify-provider";
export interface FactoryRecord { id: string; created_at: string; updated_at: string }
export type FactoryDeleteResult = { id: string; condition: "deleted" } | { id: string; condition: "pending"; reasons: string[] };
export interface FactoryDeleteAttemptResult { run_id: string; deletion_id: string; condition: "deleted" }
export interface Implementation extends FactoryRecord {
  /** Owner suspension is independent of board position and scheduler parking. */
  pause?: { id: string; condition: "pending" | "paused" | "resuming"; reasons: string[] };
  /** A pending permanent deletion takes precedence over execution controls. */
  deletion?: { id: string; condition: "pending"; reasons: string[]; local_cleanup?: "complete" };
  title: string; description: string; project_id: string | null; provider: FactoryProvider | null;
  machine_id: string | null; stage: FactoryStage; position: number;
  outcome: "none" | "implementation_complete" | "pr_open" | "merged" | "released";
  archived_at?: string | null;
}
export interface FactoryProject extends FactoryRecord {
  delivery_policy?: "merge" | "release";
  /** Explicit publication destination, frozen when the owner accepts the Specification. */
  pull_request?: { repository: string; base_branch: string } | null;
  name: string; repository: string; provider: FactoryProvider; machine_id: string;
  tracker: "app" | "github" | "gitlab" | "local"; tracker_reference: string;
  checks?: string[][]; setup?: string[][]; environment?: Record<string, string>;
  permissions?: string; shared_paths?: string[];
  permission_mode?: import("./agent-permissions.ts").AgentPermissionMode;
  execution_preset?: import("./agent-models.ts").AgentModelSelection;
  guidance_assignment_id?: string;
  account_bindings?: Record<string, ProjectAccountBindings>;
  removed_at?: string | null;
  workflow_instructions?: string;
  context_target_tokens?: number;
}
export interface ProjectCheckout extends FactoryRecord {
  project_id: string; machine_id: string; path: string; repository: string; head: string;
  branch: string; instructions: { path: string; hash: string; content: string }[];
}
export interface FactoryChat extends FactoryRecord { implementation_id: string; title: string }
/** Logical workflow identity outlives any native context. Display groups allocate no agents. */
export type FactoryConversationKind = "specifications" | "orchestrator" | "human_review" | "implementation" | "reviewer" | "standards" | "spec" | "review_fixes";
export interface FactoryConversationContext {
  run_id: string; worker_id: string | null; action: FactoryAction;
  machine_id: string; provider: FactoryProvider; condition: RunCondition;
  pane_id: string | null; workspace_id: string | null; worktree: string | null;
  snapshot_ids: string[];
}
export interface FactoryConversation {
  id: string; implementation_id: string; parent_id: string | null;
  kind: FactoryConversationKind; title: string | null; contexts: FactoryConversationContext[];
}
export interface FactoryMessage extends FactoryRecord {
  implementation_id: string; chat_id: string; role: "owner" | "agent" | "system";
  content: string; source_id: string | null; sequence: number | null;
}
export interface FactoryEvent extends FactoryRecord { implementation_id: string | null; kind: string; data: unknown }
export interface SpecificationVersion extends FactoryRecord { implementation_id: string; revision: number; content: string; hash: string; presentation_run_id?: string }
export interface FactoryTicket extends FactoryRecord {
  implementation_id: string; specification_id: string; title: string; acceptance: string;
  dependencies: string[]; status: "proposed" | "ready" | "working" | "review" | "done";
  tracker_reference: string | null;
}
export interface FactoryApproval extends FactoryRecord {
  /** Specification acceptance authorizes internal planning without further owner receipts. */
  automatic_execution?: boolean;
  implementation_id: string; kind: "specification" | "testing_seams" | "ticket_graph" | "review" | "shared_understanding"; revision: string; scope: string;
  provenance?: { kind: "button" | "owner_chat" | "native_chat"; specification_hash: string; message_id?: string; run_id?: string; snapshot_id?: string; source_id?: string; turn_ts?: string };
}
export interface FactoryExecutionPlan extends FactoryRecord {
  run_id: string; specification_id: string; hash: string; testing_plan: string; tickets: FactoryTicket[];
  authority: { kind: "specification"; approval_id: string; specification_id: string; specification_hash: string; run_id: string; contract_hash: string };
}
export interface FactoryPlanningRequest extends FactoryRecord {
  implementation_id: string; specification_id: string; approval_id: string; scope_hash: string;
  origin?: string;
  attempts?: number; next_attempt_at?: number;
  condition: "pending" | "queued" | "started" | "blocked"; reason: string | null; run_id: string | null;
}
export interface FactoryAutomaticExecution extends FactoryRecord {
  run_id: string; plan_hash: string;
  condition: "executing" | "waiting" | "blocked" | "checked";
  reason: string | null; attempts: number; next_attempt_at: number;
}
export interface FactoryAutomaticReview extends FactoryRecord {
  context_revision?: string; generation?: number; human_batch_id?: string;
  run_id: string; head: string; round: number;
  condition: "reviewing" | "repairing" | "publishing" | "published" | "waiting" | "blocked";
  reason: string | null; attempts: number; next_attempt_at: number;
  check_id: string; evidence_ids: string[]; batch_id: string | null;
}
/** Original reports are immutable; repaired-revision evidence is retained separately. */
export interface FactoryAutomaticReviewBatch extends FactoryRecord {
  implementation_id: string; run_id: string; origin: "automatic"; status: "sent";
  head: string; round: number; reports: FactoryReviewEvidence[]; ticket_ids: string[];
  resolution?: { head: string; check_id: string; evidence_ids: string[] };
}
export interface FactoryPullRequest extends FactoryRecord {
  run_id: string; head: string; repository: string; base_branch: string; branch: string;
  number: number; url: string; check_id: string; evidence_ids: string[];
}
export interface FactoryPublicationRequest {
  previous_head?: string;
  head: string; workspace_hash: string; check_id: string; evidence_ids: string[];
  reports: { worker_id: string; source_id: string }[];
}
export interface FactoryMergeRequest extends FactoryPublicationRequest { approval: FactoryHumanApproval; pull_request: FactoryPullRequest }
export interface FactoryQuestion extends FactoryRecord { implementation_id: string; run_id: string | null; worker_id?: string | null; question: string; answer_kind?: "text" | "confirmation"; answer: string | null; revision: string }
export interface FactoryArtifact extends FactoryRecord {
  implementation_id: string; chat_id: string; name: string; media_type: string;
  hash: string; size: number; version: number; origin: string; note: string;
}
export interface ProjectReference extends FactoryRecord {
  project_id: string; reference_id: string; name: string; title: string; media_type: string;
  hash: string; size: number; version: number; usage_note: string;
  read_policy: "always" | "reference"; caption: string;
}
export interface ProjectReferenceLibrary { project_id: string; revision: string; entries: ProjectReference[] }
export interface CodexReferenceContext { project_id: string; machine_id: string; revision: string; index_path: string; prompt: string }
export interface ProjectReferencePayload { library: ProjectReferenceLibrary; files: { id: string; content_base64: string }[] }
/** A waiting conversation retains its Run and native history, independently of execution. */
export interface FactoryPark extends FactoryRecord {
  kind: "owner" | "children";
  condition: "parking" | "parked" | "queued" | "sending" | "resumed" | "uncertain" | "blocked";
  reason: string;
  question_revision: string | null;
  worker_keys?: string[];
  queued_at?: string;
}
export interface FactoryRun extends FactoryRecord {
  suspension?: FactorySuspension;
  continuation?: FactoryPark;
  /** Set by the owned workflow when creating an assistant-backed Human Review context. */
  conversation_kind?: "human_review";
  /** Missing on saved Runs from before the shared planning allowance: normal. */
  capacity_pool?: "normal" | "planning";
  implementation_id: string; action: FactoryAction; provider: FactoryProvider; machine_id: string;
  condition: RunCondition; waiting_reason: string | null; idempotency_key: string;
  specification_id: string | null; graph_hash: string | null; base: string | null;
  checkout: string | null; worktree: string | null; branch: string | null;
  workspace_id: string | null; pane_id: string | null; manifest: unknown;
}
export interface ReviewSnapshot extends FactoryRecord {
  implementation_id: string; run_id: string | null; machine_id: string; repository: string;
  mode: "branch" | "workspace"; base: string; head: string; hash: string;
  files: { path: string; old_path?: string; status: string; diff: string; binary: boolean; oversized: boolean }[];
}
export interface ReviewComment extends FactoryRecord {
  implementation_id: string; run_id: string | null; snapshot_id: string; path: string; change: string;
  side: "old" | "new"; line_start: number; line_end: number; context: string;
  content: string; status: "draft" | "submitted" | "outdated" | "resolved";
  batch_id: string | null;
  resolution?: { head: string; check_id: string; summary: string };
}
export interface FactorySettings {
  provider: FactoryProvider; max_agents: number; max_builds: number;
  max_artifact_bytes: number; max_storage_bytes: number; skills_path: string | null;
}
export interface FactoryCapacityReservation {
  id: string; run_id: string; worker_id: string | null;
  implementation_id: string; assignment_title: string; project_id: string | null;
  machine_id: string; provider: FactoryProvider; label: string;
  condition: string; uncertain: boolean; reason: string | null;
}
export interface FactoryCapacityWait extends FactoryRecord {
  continuation?: boolean;
  implementation_id: string; assignment_title: string; action: FactoryAction;
  machine_id: string; provider: FactoryProvider; idempotency_key: string; reason: string;
  condition: "queued" | "blocked";
  purpose: "planning" | "execution";
  run_id: string | null;
}
export interface FactoryCapacity {
  continuations?: FactoryCapacityReservation[];
  normal: { limit: number; used: number };
  planning: { limit: 1; used: number };
  builds: { limit: number; used: number };
  contexts: (FactoryCapacityReservation & { pool: "normal" | "planning" })[];
  build_reservations: FactoryCapacityReservation[];
  waiting: FactoryCapacityWait[];
}
export interface FactoryOverview { capacity: FactoryCapacity }
export interface FactoryMergeResult {
  run_id: string; head: string; repository: string; base_branch: string; number: number;
  condition: "merged" | "awaiting_release" | "released" | "uncertain";
  merge_sha: string | null; release_tag: string | null; reason: string | null;
}
export interface FactoryHumanApproval extends FactoryRecord {
  observations?: number; next_observation_at?: number;
  implementation_id: string; review_id: string; run_id: string; snapshot_id: string; head: string;
  idempotency_key: string; provenance: { kind: "owner_button"; origin: string };
  condition: "pending" | "blocked" | FactoryMergeResult["condition"];
  reason: string | null; merge_sha: string | null; release_tag: string | null;
}
export interface FactoryHumanFeedbackBatch extends FactoryRecord {
  implementation_id: string; run_id: string; review_id: string; snapshot_id: string; head: string;
  origin: "human"; disposition: "decline"; merge_authorized: false;
  key: string; signature: string; status: "sent"; comment_ids: string[]; ticket_ids: string[];
  resolution?: { head: string; check_id: string; evidence_ids: string[] };
