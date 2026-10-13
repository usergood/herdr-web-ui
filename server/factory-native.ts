import { execFile } from "node:child_process";
import type { AgentPermissionMode } from "../shared/agent-permissions.ts";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import type { FactoryProvider, HerdrPane } from "../shared/protocol.ts";
import { agentManifests, agentPrompt, agentStart, HerdrError, sessionSnapshot, workspaceClose, workspaceCreate } from "./herdr/client.ts";

export interface FactoryNative {
  version: (provider: FactoryProvider) => Promise<string | null>;
  createWorkspace: typeof workspaceCreate;
  startAgent: typeof agentStart;
  snapshot: typeof sessionSnapshot;
  /** Archive metadata reads the bridge's existing background-task decoration. */
  paneState?: (paneId: string) => Promise<HerdrPane | null>;
  closeWorkspace: typeof workspaceClose;
  prompt: typeof agentPrompt;
}
const execute = promisify(execFile);
export const factoryNative: FactoryNative = {
  createWorkspace: workspaceCreate, snapshot: sessionSnapshot, closeWorkspace: workspaceClose, prompt: agentPrompt,
  startAgent: async (options, socketPath) => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      try { return await agentStart(options, socketPath); }
      catch (error) { if (!(error instanceof HerdrError) || error.code !== "agent_pane_busy" || Date.now() >= deadline) throw error; }
      await Bun.sleep(100); // A bounded poll for the newly created interactive shell, before any launch.
    }
  },
  version: async (provider) => {
    try {
      if (!(await agentManifests()).manifests.some((manifest) => manifest.agent === provider)) return null;
      const executable = Bun.which(provider);
      return executable ? (await execute(executable, ["--version"], { timeout: 5000, maxBuffer: 16_384 })).stdout.trim().split("\n").at(-1) || null : null;
    } catch { return null; }
  },
};

/** Keep native permission prompts; child processes must use application reservations. */
export function factoryAgentArguments(provider: FactoryProvider, cwd: string, prompt: string, readonly = false, subscriptionProfile = false, permissionMode?: AgentPermissionMode, directWork = false): string[] {
  readonly ||= permissionMode === "read_only";
  if (provider === "codex") return ["-C", cwd, ...(subscriptionProfile ? ["-c", 'cli_auth_credentials_store="file"', "-c", 'forced_login_method="chatgpt"', "-c", 'model_provider="openai"'] : []), ...(!directWork ? ["--disable", "multi_agent"] : []), "--sandbox", readonly ? "read-only" : "workspace-write", ...(permissionMode === "approve_for_me" ? readonly ? ["-a", "on-request", "-c", 'approvals_reviewer="auto_review"'] : ["--approve-for-me"] : permissionMode ? ["-a", "on-request", "-c", 'approvals_reviewer="user"'] : []), ...(!readonly ? ["notes", "state", "cache", "tmp"].flatMap((name) => ["--add-dir", join(dirname(cwd), name)]) : []), prompt];
  if (provider === "claude") return [...(!directWork ? ["--tools", "Bash,Edit,Read,Write,Glob,Grep,Skill,AskUserQuestion,TodoWrite"] : []), ...(readonly ? ["--permission-mode", "plan"] : permissionMode ? ["--permission-mode", permissionMode === "accept_edits" ? "acceptEdits" : permissionMode === "auto" ? "auto" : "default"] : []), prompt];
  return ["--agent", "saurons-eye", "--prompt", prompt];
}
