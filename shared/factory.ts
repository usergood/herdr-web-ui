/** Durable factory records. IDs belong to the application; native pane IDs are provenance. */
import type { ConversationTurn } from "./protocol.ts";
import type { ProjectAccountBindings } from "./accounts.ts";
export type FactoryProvider = "codex" | "claude" | "opencode";
export type FactoryStage = "inbox" | "specifying" | "ready" | "running" | "review" | "done";
export type FactoryBoardLane = "inbox" | "queued" | "running" | "needs_you" | "done";
export type FactoryActivity = "specifying" | "implementing" | "validating" | "reviewing" | "researching" | "setting_up" | "reflecting" | "awaiting_checks" | "awaiting_release" | "awaiting_merge" | "discard_pending";
/** A current projection; persisted stages, Runs and events remain historical records. */
export interface FactoryBoardItem {
  implementation_id: string; lane: FactoryBoardLane; activity: FactoryActivity | null;
  condition: RunCondition | null; run_id: string | null; busy: boolean; waiting_reason: string | null;
  waiting_reason_is_error?: boolean;
  delivery_completion_error?: string;
  ticket_progress: { completed: number; total: number } | null;
  /** Hide finished sidebar entries only after all owned work is reconciled. */
  sidebar_hidden?: boolean;
}
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
  /** Workflow activity is separate from verified delivery and the Board lane. */
  activity?: "awaiting_merge";
  delivery_evidence?: NonNullable<import("./github-project.ts").GitHubDependencyEdge["delivery"]> & { source_id: string; source_revision: string; requires: "merge" | "release" };
  intake?: import("./issue-queue.ts").IssueQueueEntry;
  title: string; description: string; project_id: string | null; provider: FactoryProvider | null;
  machine_id: string | null; stage: FactoryStage; position: number;
  outcome: "none" | "implementation_complete" | "research_accepted" | "pr_open" | "merged" | "released" | "discarded";
  archived_at?: string | null;
  discard_requested_at?: string | null;
  /** Fixed at the first accepted Run, including its committed repository baseline. */
  delivery_scope?: { milestone: "merge" | "release"; repository: string | null; branch: string | null; base: string | null; github_repository?: string | null };
  completion_evidence?: { repository_changes: "none" | "changes" | "unknown"; quiescent: boolean; reason: string | null; checked_at: string };
  delivery?: AssignmentDelivery;
  upstream_update?: import("./upstream-releases.ts").UpstreamRelease;
}
export interface DeliveryChange { path: string; oid: string | null; mode: string | null; old_path?: string }
export interface AssignmentDelivery {
  revision: string; machine_id: string; account_profile_id: string; repository: string; branch: string;
  pull_numbers: number[]; condition: "linked" | "needs_you" | "merged" | "released";
  changes: DeliveryChange[];
  pulls: { number: number; url: string; head: string; merge_commit: string; covered_paths: string[] }[];
  branch_head?: string;
  /** Published release whose resolved tag contains every verified delivery merge. */
  release?: { id: number; tag: string; url: string; commit: string; published_at: string; merge_commits: string[] };
  problem: string | null; checked_at: string | null;
}
export interface AssignmentDeliveryConfiguration { expected_revision: string | null; machine_id: string; account_profile_id: string; pull_numbers: number[] }
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
  delivery_branch?: string;
  /** Separate publication authority. Missing on older Projects means disabled. */
  auto_publish_pr?: boolean;
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
/** Sidebar context identity; native provenance is read with the selected conversation. */
export type FactoryNavigationConversation = Omit<FactoryConversation, "contexts"> & { contexts: Pick<FactoryConversationContext, "run_id" | "worker_id">[] };
export interface FactoryMessage extends FactoryRecord {
  implementation_id: string; chat_id: string; role: "owner" | "agent" | "system";
  content: string; source_id: string | null; sequence: number | null;
}
export interface FactoryEvent extends FactoryRecord { implementation_id: string | null; kind: string; data: unknown }
export interface SpecificationVersion extends FactoryRecord {
  implementation_id: string; revision: number; content: string; hash: string; presentation_run_id?: string;
  /** The detected release this revision proposes to prepare; never a moving candidate. */
  upstream_update?: import("./upstream-releases.ts").UpstreamRelease;
}
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
  /** Issue scope observed by the app at this explicit planning decision; absent on legacy receipts. */
  issue_scope?: { source_id: string; source_revision: string; scope_hash?: string };
  /** Trusted readiness receipt reused by the Project issue workflow. */
  source_approval_id?: string;
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
  reason: string | null; reason_is_error?: boolean; attempts: number; next_attempt_at: number;
}
export interface FactoryAutomaticReview extends FactoryRecord {
  context_revision?: string; generation?: number; human_batch_id?: string;
  run_id: string; head: string; round: number;
  condition: "reviewing" | "repairing" | "publishing" | "published" | "waiting" | "blocked";
  reason: string | null; reason_is_error?: boolean; attempts: number; next_attempt_at: number;
  check_id: string; evidence_ids: string[]; batch_id: string | null;
}
/** Original reports are immutable; repaired-revision evidence is retained separately. */
export interface FactoryAutomaticReviewBatch extends FactoryRecord {
  human_batch_id?: string;
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
  /** Execution was reconciled at this checked revision; owner acceptance remains separate. */
  implementation_completion?: { head: string; workspace_hash: string; check_id: string; standards_id: string; spec_id: string };
  implementation_completion_pending?: boolean;
  /** Verified delivery is retained while history/shutdown recovery remains incomplete. */
  delivery_completion_error?: string;
  implementation_id: string; action: FactoryAction; provider: FactoryProvider; machine_id: string;
  condition: RunCondition; waiting_reason: string | null; idempotency_key: string;
  specification_id: string | null; graph_hash: string | null; base: string | null;
  checkout: string | null; worktree: string | null; branch: string | null;
  workspace_id: string | null; pane_id: string | null; manifest: unknown;
  retry_of?: string;
  issue_pause?: import("./issue-admission.ts").IssuePause;
  scope_pause?: { source_id: string; approved_revision: string; observed_revision: string; condition: "requested" | "paused" | "uncertain"; reason: string };
  accepted_result?: { head: string; workspace_hash: string; check_id: string; review_ids: string[]; question_revision: string };
}
/** Frozen manifest.rework source for an explicit Retry; the retired lease stays closed. */
export interface FactoryRework { run_id: string; head: string; workspace_hash: string }
export interface ReviewSnapshot extends FactoryRecord {
  implementation_id: string; run_id: string | null; machine_id: string; repository: string;
  mode: "branch" | "workspace"; base: string; head: string; hash: string;
  files: { path: string; status: string; diff: string; binary: boolean; oversized: boolean; new_oid?: string | null; new_mode?: string | null; old_path?: string }[];
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
  machine_id: string; provider: FactoryProvider; idempotency_key: string; reason: string; reason_is_error?: boolean;
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
  /** Exact owner-question context; legacy authority without it requires a fresh owner decision. */
  context_revision?: string;
  /** No merge mutation sent, or the Machine positively confirmed protection blocked before send. */
  merge_not_sent?: boolean;
  /** Retained history, revoked only by an explicit owner feedback submission. */
  superseded_by_batch_id?: string;
  observations?: number; next_observation_at?: number;
  repair_batch_id?: string; repair_scope?: string; repair_signature?: string; original_candidate?: { head: string; snapshot_id: string };
  implementation_id: string; review_id: string; run_id: string; snapshot_id: string; head: string;
  idempotency_key: string; provenance: { kind: "owner_button"; origin: string };
  condition: "repairing" | "pending" | "blocked" | FactoryMergeResult["condition"];
  reason: string | null; reason_is_error?: boolean; merge_sha: string | null; release_tag: string | null;
}
export interface FactoryHumanFeedbackBatch extends FactoryRecord {
  implementation_id: string; run_id: string; review_id: string; snapshot_id: string; head: string;
  origin: "human"; disposition: "decline" | "approve"; merge_authorized: boolean;
  key: string; signature: string; status: "sent"; comment_ids: string[]; ticket_ids: string[];
  resolution?: { head: string; check_id: string; evidence_ids: string[] };
}
export interface FactoryHumanReviewDelivery {
  id: string; review_id: string;
  condition: "queued" | "sending" | "sent" | "uncertain"; reason: string | null;
}
export interface FactoryHumanReview extends FactoryRecord {
  implementation_id: string; run_id: string; conversation_id: string;
  head: string; snapshot_id: string | null; assistant_run_id: string | null;
  condition: "capturing" | "ready" | "repairing" | "waiting" | "blocked"; reason: string | null; reason_is_error?: boolean;
}
export interface FactoryDetail {
  human_review_approvals?: FactoryHumanApproval[];
  human_feedback_batches?: FactoryHumanFeedbackBatch[];
  human_reviews?: FactoryHumanReview[];
  human_review_deliveries?: FactoryHumanReviewDelivery[];
  automatic_review_batches?: FactoryAutomaticReviewBatch[];
  pull_requests?: FactoryPullRequest[];
  automatic_review?: FactoryAutomaticReview[];
  automatic_execution?: FactoryAutomaticExecution[];
  automatic_planning?: FactoryPlanningRequest[];
  execution_plans?: FactoryExecutionPlan[];
  capacity_waiting?: FactoryCapacityWait[];
  conversations?: FactoryConversation[];
  /** Absent on older servers. Source observations are separate from notes and frozen Runs. */
  github_sources?: import("./github-project.ts").ProjectGitHubSource[];
  github_sync?: { last_sync: string | null; problem: string | null } | null;
  /** Absent on older bridges. */
  board?: FactoryBoardItem;
  graph_hash: string; question_revision: string;
  /** Current decision scope; full historical questions remain in questions below. */
  question_context?: { revision: string; questions: FactoryQuestion[]; run_id: string | null };
  implementation: Implementation; chats: FactoryChat[]; messages: FactoryMessage[];
  specifications: SpecificationVersion[]; tickets: FactoryTicket[]; approvals: FactoryApproval[];
  questions: FactoryQuestion[]; artifacts: FactoryArtifact[]; runs: FactoryRun[];
  snapshots: ReviewSnapshot[]; comments: ReviewComment[]; events: FactoryEvent[];
  workers: FactoryWorker[]; checks: FactoryCheck[]; review_evidence: FactoryReviewEvidence[];
  review_batches?: import("./protocol.ts").FactoryBatchReceipt[];
  frontier: FactoryTicket[];
  retrospectives: FactoryRetrospective[];
  native_snapshots: NativeConversationSnapshot[];
}
export interface FactoryOverview { implementations: FactoryImplementationSummary[]; projects: FactoryProject[]; checkouts: (Omit<ProjectCheckout, "instructions"> & { instructions?: ProjectCheckout["instructions"] })[]; settings: FactorySettings; activity: { implementation_id: string; run_id: string; condition: RunCondition; action: FactoryAction; waiting_reason: string | null; completed_tickets: number; total_tickets: number }[] }
export interface FactoryPaneLink {
  project_id?: string | null;
  worktree: string | null; workspace_id: string | null;
  implementation_id: string; run_id: string; worker_id: string | null;
  machine_id: string; pane_id: string; provider: FactoryProvider;
  title: string; condition: RunCondition;
}
export interface FactoryPaneArchive extends FactoryRecord { machine_id: string; pane_id: string; terminal_id?: string; session_ref?: string | null; title?: string; archived_at: string | null }
export interface FactoryOverview { pane_links?: FactoryPaneLink[]; pane_archives?: FactoryPaneArchive[]; conversations?: FactoryNavigationConversation[]; board?: FactoryBoardItem[] }
export interface FactoryProviderCapability { provider: FactoryProvider; version: string | null; installed: boolean; skills_verified: boolean; factory_ready: boolean; reasons: string[] }
export interface FactoryCapabilities { providers: FactoryProviderCapability[]; skill_manifest: { commit: string; hash: string; file_count: number } | null; factory_host_protocol: 1; human_review_protocol?: 1; implementation_rework_protocol?: 1; project_reference_protocol?: 1; account_profile_protocol?: 1 }
export interface FactoryOutput { name: string; media_type: string; hash: string; size: number }
export interface FactoryWorker extends FactoryRecord {
  /** The Machine merged this candidate; central progress/cleanup still needs its receipt. */
  integration_pending?: boolean;
  suspension?: FactorySuspension;
  continuation?: FactoryPark;
  /** Frozen when repair work is accepted; never inferred from the latest review stage. */
  review_origin?: "automatic" | "human";
  run_id: string; ticket_id: string; role: "implementer" | "standards" | "spec";
  condition: RunCondition; base: string; head: string | null; integration_tip: string;
  worktree: string | null; branch: string | null; workspace_id: string | null; pane_id: string | null;
  shared_paths: string[]; waiting_reason: string | null;
  rework_batch_id: string | null;
}
export interface FactorySuspension {
  queued_at?: string;
  pause_id: string; condition: "stopped" | "resuming" | "uncertain";
  previous_condition: RunCondition;
}
export interface FactoryPauseResult { run: FactoryRun; workers: FactoryWorker[]; checks: FactoryCheck[] }
export interface FactoryCheck extends FactoryRecord {
  run_id: string; worker_id: string | null; head: string; workspace_hash: string;
  commands: { args: string[]; exit_code: number; output: string }[];
  condition: "working" | "passed" | "failed" | "interrupted" | "cancelled";
  /** Confirmed build shutdown by this Pause; unfinished validation is rerun on Resume. */
  pause_id?: string;
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
  /** Absent/null on historical coordinator captures. */
  worker_id?: string | null;
  run_id: string; source_id: string; sequence: number; version: string;
  turns: ConversationTurn[]; cursor: string | null;
}

/** Public board projection; counts cover the complete current Ticket scope. */
export type FactoryAssignmentActivity = "specifying" | "implementing" | "testing" | "auto_review" | "fixing";
export interface FactoryAssignmentProgress {
  implementation_id: string; lane: FactoryBoardLane; activities: FactoryAssignmentActivity[];
  counts: { waiting: number; running: number; completed: number };
  tickets: { ticket_id: string; title: string; state: "waiting" | "running" | "completed"; reason: string | null }[];
  reasons: string[];
  /** Known failures are assertive; ordinary waits remain only in reasons. */
  error_reasons?: string[];
}
export interface FactoryOverview { progress: FactoryAssignmentProgress[] }
/** Pollable owner decisions. Historical collections and evidence bodies are fetched on demand. */
export type FactoryCurrent = Pick<FactoryDetail, "github_sources" | "github_sync" | "implementation" | "board" | "graph_hash" | "question_revision" | "question_context" | "specifications" | "tickets" | "approvals" | "questions" | "events" | "runs" | "conversations" | "execution_plans" | "automatic_planning" | "automatic_execution" | "automatic_review" | "capacity_waiting" | "human_reviews" | "pull_requests"> & {
  workers: FactoryWorker[];
  automatic_review_batches?: Omit<FactoryAutomaticReviewBatch, "reports">[];
  /** Changes when retained data changes, including evidence outside this summary. */
  revision: string;
  checks: Omit<FactoryCheck, "commands">[];
  review_evidence: Omit<FactoryReviewEvidence, "content">[];
};
export type FactoryReviewDetail = Pick<FactoryCurrent, "implementation" | "runs" | "checks" | "review_evidence"> & {
  snapshots: Omit<ReviewSnapshot, "files">[];
  comments: ReviewComment[];
  review_batches: Omit<import("./protocol.ts").FactoryBatchReceipt, "reports">[];
};
export type FactoryImplementationSummary = Omit<Implementation, "description" | "delivery" | "upstream_update">;
