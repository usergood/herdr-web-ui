import { execFile } from "node:child_process";
import type { AgentPermissionMode } from "../shared/agent-permissions.ts";
import { promisify } from "node:util";
import { dirname, join, relative, isAbsolute, resolve } from "node:path";
import { realpathSync } from "node:fs";
import type { FactoryProvider, FactoryRun, HerdrPane, SessionSnapshot } from "../shared/protocol.ts";
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
/** Only a complete observation can release a closed native context's ownership. */
export function factoryWorkspaceGone(snapshot: SessionSnapshot, owned: Pick<FactoryRun, "worktree" | "workspace_id" | "pane_id">, label: string): boolean {
  if (!owned.worktree || !owned.workspace_id || !owned.pane_id) return false;
  try { if (realpathSync(owned.worktree) !== owned.worktree) return false; } catch { return false; }
  const couldOwn = (cwd: string | null | undefined): boolean => {
    if (!cwd) return false;
    const within = (path: string) => { const offset = relative(owned.worktree!, path); return !offset || offset !== ".." && !offset.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(offset); };
    if (within(resolve(cwd))) return true;
    try { return within(realpathSync(cwd)); } catch { return true; }
  };
  return !snapshot.workspaces.some(entry => entry.workspace_id === owned.workspace_id || entry.label === label)
    && !snapshot.panes.some(entry => entry.pane_id === owned.pane_id || entry.workspace_id === owned.workspace_id || !entry.cwd && !entry.foreground_cwd || couldOwn(entry.cwd) || couldOwn(entry.foreground_cwd));
}
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

/** A decorated resting state belongs to the same native identity, with no background work. */
export async function factoryPaneResting(native: FactoryNative, pane: Pick<HerdrPane, "pane_id" | "workspace_id" | "terminal_id" | "agent" | "agent_status">, provider: FactoryProvider): Promise<boolean> {
  const state = native.paneState ? await native.paneState(pane.pane_id) : pane;
  return !!state && state.pane_id === pane.pane_id && state.workspace_id === pane.workspace_id && state.terminal_id === pane.terminal_id && state.agent === provider
    && ["idle", "done"].includes(state.agent_status) && !("background_wait" in state && state.background_wait) && !("background_tasks" in state && state.background_tasks);
}

/** Keep native permission prompts; child processes must use application reservations. */
export function factoryAgentArguments(provider: FactoryProvider, cwd: string, prompt: string, readonly = false, subscriptionProfile = false, permissionMode?: AgentPermissionMode, directWork = false, preset?: AgentExecutionPreset): string[] {
  readonly ||= permissionMode === "read_only";
  const modelArgs = preset?.model ? ["--model", provider === "opencode" && preset.reasoning && preset.reasoning_format === "model_suffix" ? `${preset.model}#${preset.reasoning}` : preset.model, ...(preset.reasoning ? provider === "codex" ? ["-c", `model_reasoning_effort=${JSON.stringify(preset.reasoning)}`] : provider === "claude" ? ["--effort", preset.reasoning] : [] : [])] : [];
  if (provider === "codex") return ["-C", cwd, ...modelArgs, ...(subscriptionProfile ? ["-c", 'cli_auth_credentials_store="file"', "-c", 'forced_login_method="chatgpt"', "-c", 'model_provider="openai"'] : []), ...(!directWork ? ["--disable", "multi_agent"] : []), "--sandbox", readonly ? "read-only" : "workspace-write", ...(permissionMode ? ["-a", "on-request", "-c", permissionMode === "approve_for_me" ? 'approvals_reviewer="auto_review"' : 'approvals_reviewer="user"'] : []), ...(!readonly ? ["notes", "state", "cache", "tmp"].flatMap((name) => ["--add-dir", join(dirname(cwd), name)]) : []), prompt];
  if (provider === "claude") return [...modelArgs, ...(!directWork ? ["--tools", "Bash,Edit,Read,Write,Glob,Grep,Skill,AskUserQuestion,TodoWrite"] : []), ...(readonly ? ["--permission-mode", "plan"] : permissionMode ? ["--permission-mode", permissionMode === "accept_edits" ? "acceptEdits" : permissionMode === "auto" ? "auto" : "default"] : []), prompt];
  return [...modelArgs, "--agent", "saurons-eye", "--prompt", prompt];
}
