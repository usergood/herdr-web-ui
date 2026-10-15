import type { FactoryRecord } from "./factory.ts";
import type { AccountIdentity } from "./accounts.ts";

export const TRIAGE_ROLES = ["needs-triage", "needs-info", "ready-for-agent", "ready-for-human", "wontfix"] as const;
export type TriageRole = typeof TRIAGE_ROLES[number];
export type TriageLabels = Record<TriageRole, string>;
export interface ProjectReadinessPolicy extends FactoryRecord {
  project_id: string; revision: string; repository: string; project_scope: string;
  account_profile_id: string; owner: AccountIdentity; triage_labels: TriageLabels; blocked_label: string;
}
export interface ReadinessConfiguration {
  expected_revision: string | null; account_profile_id: string;
  triage_labels: Partial<TriageLabels>; blocked_label: string;
}

export type ReadinessBlocker = "identity_required" | "mapping_conflict" | "role_not_ready" | "triage_conflict" | "blocked" | "closed" | "evidence_missing" | "evidence_incomplete" | "untrusted" | "stale" | "sync_required" | "policy_changed";
export interface IssueReadinessApproval {
  id: string; evidence_revision: string; source_revision: string; policy_revision: string; approved_at: string;
  actor: AccountIdentity; provenance: "github_label" | "app_owner"; event_id: string | null;
}
export interface ReadinessLabelEvent { id: string; event: "labeled" | "unlabeled"; login: string | null; account_id: string | null; created_at: string }
export interface IssueReadinessEvidence {
  revision: string; source_revision: string; policy_revision: string; complete: boolean; problem: string | null;
  label_event: ReadinessLabelEvent | null;
}
export interface IssueReadiness { eligible: boolean; roles: TriageRole[]; blockers: ReadinessBlocker[]; approval: IssueReadinessApproval | null }
/** Readiness alone is one prerequisite; it never admits or dispatches a Run. */
export function issueReadiness(policy: ProjectReadinessPolicy | null, source: import("./github-project.ts").ProjectGitHubSource): IssueReadiness {
  const blockers: ReadinessBlocker[] = [];
  const labels = source.current?.labels.map(label => label.toLowerCase()) ?? [];
  const mapping = policy?.triage_labels ?? Object.fromEntries(TRIAGE_ROLES.map(role => [role, role])) as TriageLabels;
  const roles = TRIAGE_ROLES.filter(role => labels.includes(mapping[role].toLowerCase()));
  if (!policy) blockers.push("identity_required");
  if (new Set([...Object.values(mapping), policy?.blocked_label ?? "blocked"].map(label => label.toLowerCase())).size !== 6) blockers.push("mapping_conflict");
  if (source.current?.state !== "open") blockers.push("closed");
  if (roles.length > 1) blockers.push("triage_conflict");
  if (roles.length !== 1 || roles[0] !== "ready-for-agent") blockers.push("role_not_ready");
  if (labels.includes((policy?.blocked_label ?? "blocked").toLowerCase())) blockers.push("blocked");
  const evidence = source.readiness_evidence;
  const event = evidence?.label_event;
  const approval = source.readiness_approvals?.slice().reverse().find(approval => approval.evidence_revision === evidence?.revision && approval.source_revision === source.revision && approval.policy_revision === policy?.revision && (approval.provenance === "app_owner" || approval.event_id === event?.id)) ?? null;
  if (!evidence || evidence.source_revision !== source.revision || evidence.policy_revision !== policy?.revision) blockers.push("sync_required");
  else if (!evidence.complete) blockers.push("evidence_incomplete");
  if (!approval) {
    if (!event || event.event !== "labeled") blockers.push("evidence_missing");
    else if (event.login?.toLowerCase() !== policy?.owner.login.toLowerCase() || !event.account_id || event.account_id !== policy?.owner.account_id) blockers.push("untrusted");
    else blockers.push("stale");
  }
  return { eligible: blockers.length === 0, roles, blockers, approval };
}
