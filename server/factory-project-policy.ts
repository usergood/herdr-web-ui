import type { FactoryProject } from "../shared/factory.ts";

/** The Project is read from the immutable Run manifest, never from live settings. */
export function projectWorkflowPrompt(project: FactoryProject | null | undefined): string {
  if (!project) return "";
  return `\nFrozen Project workflow: ${project.workflow_instructions || "Follow the verified repository instructions and pinned skills."}\nContext handoff target: ${project.context_target_tokens ?? 150000} tokens. This is a planning target, not a measured hard limit. Keep each Ticket bounded. Use fresh app-owned Ticket workers and separate Standards and Spec reviewers; do not grow one conversation through the entire backlog. Before approaching the target, retain a concise handoff with accepted scope, decisions, changed files, checks, findings and remaining work. Report a need for a new worker rather than spawning unmanaged children or abandoning a write lease. Project guidance never bypasses approvals, known checks, native permissions or independent review.\n`;
}
