import type { FactoryProvider } from "./factory.ts";

export type AgentPermissionMode = "ask" | "approve_for_me" | "accept_edits" | "auto" | "read_only" | "allow";
export const AGENT_PERMISSION_MODES: Record<FactoryProvider, readonly AgentPermissionMode[]> = {
  codex: ["ask", "approve_for_me", "read_only"],
  claude: ["ask", "accept_edits", "auto", "read_only"],
  opencode: ["ask", "allow", "read_only"],
};
export function validPermissionMode(provider: FactoryProvider, value: unknown): value is AgentPermissionMode {
  return typeof value === "string" && AGENT_PERMISSION_MODES[provider].includes(value as AgentPermissionMode);
}
export function permissionDescription(mode: AgentPermissionMode): string {
  switch (mode) {
    case "approve_for_me": return "Use Codex automatic review of approval requests within the workspace-write sandbox. Publication and deployment require their separate owner actions.";
    case "accept_edits": return "Accept repository file edits using Claude's native acceptEdits mode; retain native command approval and separate publication gates.";
    case "auto": return "Use Claude's native automatic permission review; retain separate publication and deployment gates.";
    case "allow": return "Allow the selected OpenCode agent's tools within its owned worktree; retain managed worker limits and separate publication gates.";
    case "read_only": return "Use the native read-only or planning mode; preserve repository files and separate publication gates.";
    default: return "Ask through the native agent's permission controls before commands or edits that require approval; preserve separate publication gates.";
  }
}
