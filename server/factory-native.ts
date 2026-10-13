import { execFile } from "node:child_process";
import type { AgentPermissionMode } from "../shared/agent-permissions.ts";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import type { FactoryProvider, HerdrPane } from "../shared/protocol.ts";
import { agentManifests, agentPrompt, agentStart, HerdrError, sessionSnapshot, workspaceClose, workspaceCreate } from "./herdr/client.ts";
import { readAgentModelCatalog } from "./agent-model-catalog.ts";
import type { AgentExecutionPreset } from "../shared/agent-models.ts";

export interface FactoryNative {
  modelCatalog: (provider: FactoryProvider, cwd: string) => Promise<import("../shared/agent-models.ts").AgentModelCatalog>;
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
  modelCatalog: readAgentModelCatalog,
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
export function factoryAgentArguments(provider: FactoryProvider, cwd: string, prompt: string, readonly = false, subscriptionProfile = false, permissionMode?: AgentPermissionMode, directWork = false, preset?: AgentExecutionPreset): string[] {
  readonly ||= permissionMode === "read_only";
  const modelArgs = preset?.model ? ["--model", provider === "opencode" && preset.reasoning && preset.reasoning_format === "model_suffix" ? `${preset.model}#${preset.reasoning}` : preset.model, ...(preset.reasoning ? provider === "codex" ? ["-c", `model_reasoning_effort=${JSON.stringify(preset.reasoning)}`] : provider === "claude" ? ["--effort", preset.reasoning] : [] : [])] : [];
  if (provider === "codex") return ["-C", cwd, ...modelArgs, ...(subscriptionProfile ? ["-c", 'cli_auth_credentials_store="file"', "-c", 'forced_login_method="chatgpt"', "-c", 'model_provider="openai"'] : []), ...(!directWork ? ["--disable", "multi_agent"] : []), "--sandbox", readonly ? "read-only" : "workspace-write", ...(permissionMode === "approve_for_me" ? readonly ? ["-a", "on-request", "-c", 'approvals_reviewer="auto_review"'] : ["--approve-for-me"] : permissionMode ? ["-a", "on-request", "-c", 'approvals_reviewer="user"'] : []), ...(!readonly ? ["notes", "state", "cache", "tmp"].flatMap((name) => ["--add-dir", join(dirname(cwd), name)]) : []), prompt];
  if (provider === "claude") return [...modelArgs, ...(!directWork ? ["--tools", "Bash,Edit,Read,Write,Glob,Grep,Skill,AskUserQuestion,TodoWrite"] : []), ...(readonly ? ["--permission-mode", "plan"] : permissionMode ? ["--permission-mode", permissionMode === "accept_edits" ? "acceptEdits" : permissionMode === "auto" ? "auto" : "default"] : []), prompt];
  return [...modelArgs, "--agent", "saurons-eye", "--prompt", prompt];
}
