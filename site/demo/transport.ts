/**
 * The browser demo's stand-in for the server. Loaded before the app on the demo page, it answers
 * `fetch("/api/…")`, `new EventSource("/api/machines/events")` and `new WebSocket("…/ws")` from
 * fixtures (site/demo/fixtures/, captured by scripts/demo-fixtures.ts from the staged fictional
 * session) instead of the network. The app's own code is unchanged: it believes it talks to a
 * herdr web ui server on a PC called "workstation".
 *
 * What works: the sidebar and its live statuses, every chat, the Codex approval card (answering it
 * sets Codex to work and ends the turn), the command palette, settings, and the terminal: the shell
 * pane replays a recording of `git log` and `bun test`, then a small pretend shell answers what you
 * type. `demo logs` loads fictional retained history for scrolling and search; agent panes show
 * one notice instead of a TUI. A message sent from a chat gets a demo answer.
 * What does not: files, images, push and remote PCs, which need a real machine.
 */
import type { AgentIntegration, AgentStatus, ConversationTurn, IntegrationsResponse, Machine, MachineEvent, PaneDirection, PaneFindMatch, PaneFindRequest, PaneMoved, PanePlan, PaneResized, PaneSplit, PaneSwapped, PaneZoomed, PendingMessage, PlanStep, PluginActionResult, PluginActions, PluginActionsResponse, PortalStatus, ServerMessage, SessionSnapshot, TabMoved, UsageReport, WorkspaceCreated, WorkspaceInfo, WorktreeEntry, WorktreeListing, WorktreeOpened, WorktreeRemoved } from "../../shared/protocol.ts";
import { VOICE_DEFAULTS, type VoiceStatus } from "../../shared/voice.ts";
import { isAgentName } from "../../shared/agent-name.ts";
import { sharedPreferencesBody, type SharedPreferences } from "../../shared/preferences.ts";
import { neighborPane } from "../../src/lib/layoutMap.ts";
import { closeLayoutPane, resizeLayout, setLayoutSplitRatio, splitLayout, swapLayoutPanes } from "../../src/lib/layoutTree.ts";
import { rollupStatus } from "../../src/lib/status.ts";
import { CHATS, PROMPT, SPECS } from "./fixtures.ts";
import { DemoHistory } from "./history.ts";
import machinesFixture from "./fixtures/machines.json";
import agentsFixture from "./fixtures/agents.json";
import commandsFixture from "./fixtures/commands.json";
import panesFixture from "./fixtures/panes.json";
import terminalFixture from "./fixtures/terminal.json";
import { factoryDemo } from "./factory.ts";

const DEMO_VERSION = "demo";
/** Only an explicit `demo logs` command starts this fictional retained history. */
const histories = new Map<string, DemoHistory>();
const terminalGrids = new Map<string, { cols: number; rows: number }>();
const demoGrid = (paneId: string) => terminalGrids.get(paneId) ?? { cols: 80, rows: 24 };
function redrawHistory(paneId: string): void {
  for (const socket of sockets) socket.renderHistory(paneId);
}
const PROMPT_ANSWER_TURN_MS = 2600;
const CHAT_ANSWER_MS = 2400;
/** the recording's gaps, capped so the replay stays brisk */
const MAX_FRAME_GAP_MS = 500;
/** Settings → Agent integrations: one of each state, in herdr's order */
const integrationsFixture: AgentIntegration[] = [
  ["pi", "pi", true, "not_installed"], ["omp", "omp", false, "not_installed"], ["claude", "claude", true, "current"],
  ["codex", "codex", true, "outdated"], ["copilot", "copilot", false, "not_installed"], ["opencode", "opencode", true, "not_installed"],
  ["cursor", "cursor-agent", false, "not_installed"], ["antigravity_cli", "agy", false, "not_installed"],
].map(([target, command, available, state]) => ({ target: target as string, label: (target as string).replace("_", "-"), command: command as string, available: available as boolean, state: state as string }));

type Pane = SessionSnapshot["panes"][number];
type Tab = SessionSnapshot["tabs"][number];
type Layout = SessionSnapshot["layouts"][number];
type SseListener = (event: MessageEvent) => void;

// ---- state -----------------------------------------------------------------------------------

const machines: Machine[] = structuredClone(machinesFixture.machines as Machine[]);
const local = machines[0]!;
let preferences: SharedPreferences = { revision: 0, settings: {} };
const snapshot = (): SessionSnapshot => local.snapshot!;
/** pane id -> fixture key ("api", "web", …) */
const keyOfPane = new Map<string, string>(Object.entries(panesFixture as Record<string, string>).map(([key, paneId]) => [paneId, key]));
const chats = new Map<string, { turns: ConversationTurn[]; metadata: { model: string; reasoning_effort: string } }>(
  Object.entries(CHATS).map(([key, chat]) => [key, structuredClone(chat)]),
);
// The fixtures' clocks say September 25th; the demo happens now. Every timestamp moves by the same
// amount, so "Worked for" stays what it was and the newest turn ended three minutes ago.
{
  const stamps = [...chats.values()].flatMap((chat) => chat.turns.flatMap((turn) => [turn.ts, turn.end_ts].filter((v): v is string => typeof v === "string")));
  const newest = Math.max(...stamps.map((v) => Date.parse(v)));
  const shift = Date.now() - 3 * 60_000 - newest;
  for (const chat of chats.values()) for (const turn of chat.turns) {
    if (turn.ts) turn.ts = new Date(Date.parse(turn.ts) + shift).toISOString();
    if (turn.end_ts) turn.end_ts = new Date(Date.parse(turn.end_ts) + shift).toISOString();
  }
}
let promptOpen = true;
let promptId = PROMPT.id;
let nextWorkspace = 100;
let nextPending = 1;
const replying = new Set(snapshot().panes.filter((pane) => pane.agent && pane.agent_status === "working").map((pane) => pane.pane_id));
/** herdr's state_change_seq: one counter per session, bumped on every agent state change */
let stateSeq = Math.max(0, ...(local.snapshot?.agents ?? []).map((agent) => agent.state_change_seq ?? 0));
const nextStateSeq = (): number => ++stateSeq;
/** herdr lists an agent pane under `agents` too, with the counter the sidebar's Activity order reads */
// taken once, as the pane, tab and workspace templates are: the last agent can be closed in a demo
const agentTemplate = local.snapshot?.agents[0] ? structuredClone(local.snapshot.agents[0]) : null;
function addAgent(pane: Pane): void {
  const snap = snapshot();
  if (!pane.agent || !agentTemplate || snap.agents.some((agent) => agent.pane_id === pane.pane_id)) return;
  snap.agents.push({ ...structuredClone(agentTemplate), pane_id: pane.pane_id, tab_id: pane.tab_id, workspace_id: pane.workspace_id, terminal_id: pane.terminal_id,
    agent: pane.agent, agent_status: pane.agent_status, cwd: pane.cwd, foreground_cwd: pane.foreground_cwd, state_change_seq: nextStateSeq() });
}

/** The OmO pane's background tasks (the composer's "2 background tasks"), timed from now. */
const OMO_TASKS_PANE = "docs";
const ago = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString();
const planSteps: PlanStep[] = [
  { id: "1", label: "Trace replayed requests", active: null, status: "completed", blocked_by: [], owner: null, started_at: ago(8), ended_at: ago(6) },
  { id: "2", label: "Count idempotent replays", active: "Adding the replay metric", status: "in_progress", blocked_by: ["1"], owner: null, started_at: ago(5), ended_at: null },
  { id: "3", label: "Cover the metric with tests", active: null, status: "pending", blocked_by: ["2"], owner: null, started_at: null, ended_at: null },
];
const omoTasks = () => [
  { id: "st_demo1", title: "Check every link in the guide", category: "quick", model: "Claude Haiku 4.5", status: "running", started_at: ago(3), ended_at: null, turns: 6, tool_calls: 41, tokens: 52_300 },
  { id: "st_demo2", title: "Rewrite the install section for Windows", category: "writing", model: "Claude Opus 5.5", status: "running", started_at: ago(1), ended_at: null, turns: 2, tool_calls: 7, tokens: 18_900 },
  { id: "st_demo3", title: "Find pages that still say v0.2", category: "quick", model: "Claude Haiku 4.5", status: "completed", started_at: ago(26), ended_at: ago(22), turns: 9, tool_calls: 33, tokens: 61_200 },
  { id: "st_demo4", title: "Translate the FAQ to Korean", category: "writing", model: "GPT-6.1", status: "failed", started_at: ago(48), ended_at: ago(44), turns: 3, tool_calls: 5, tokens: 12_000 },
];
const step = (id: string, state: string, error: string | null = null) => ({ id, label: id, state, error });
const omoRuns = () => [
  { id: "dag_demo1", name: "Guide release check", status: "running", started_at: ago(6), ended_at: null, waves: [
    [step("find stale pages", "completed"), step("check links", "running"), step("rewrite install", "running")],
    [step("proofread", "pending")],
    [step("open PR", "pending")],
  ] },
  { id: "dag_demo2", name: "FAQ translations", status: "failed", started_at: ago(50), ended_at: ago(43), waves: [
    [step("ko", "failed", "the glossary file was missing"), step("ja", "completed")],
    [step("review", "skipped")],
  ] },
];

/**
 * A pane the fixtures predate. `fixtures/panes.json` and `fixtures/machines.json` are recorded
 * together by `bun scripts/demo-fixtures.ts`, which drives a live herdr and renumbers every pane,
 * so a fixture is rarely re-cut for one pane's sake. A SPECS entry with no recorded pane gets one
 * here instead, which keeps adding an agent to the demo to a change in `fixtures.ts` alone. Panes
 * the fixtures do record are left exactly as they were recorded.
 */
/** herdr lays a new tab out as its one pane over the whole area: the demo's layout for it, so the layout operations find the pane. */
function addDemoLayout(workspaceId: string, tabId: string, paneId: string): void {
  const area = { x: 0, y: 0, width: 120, height: 40 };
  snapshot().layouts.push({ workspace_id: workspaceId, tab_id: tabId, zoomed: false, area, focused_pane_id: paneId, panes: [{ pane_id: paneId, focused: true, rect: { ...area } }], splits: [] });
}

function backfillPanes(): void {
  const snap = snapshot();
  const recorded = new Set<string>(keyOfPane.values());
  const template = snap.workspaces[0];
  const paneTemplate = snap.panes[0];
  if (!template || !paneTemplate) return;
  for (const spec of SPECS) {
    if (recorded.has(spec.key)) continue;
    const id = `w${(nextWorkspace++).toString(36)}`;
    const pane: Pane = { ...structuredClone(paneTemplate), pane_id: `${id}:p1`, tab_id: `${id}:t1`, terminal_id: `${id}:term`, workspace_id: id, label: spec.title, title: spec.title, agent: spec.agent, agent_status: spec.agent ? spec.state ?? "idle" : "unknown", cwd: `/home/demo/${spec.label}`, foreground_cwd: `/home/demo/${spec.label}` };
    snap.panes.push(pane);
    addAgent(pane);
    snap.tabs.push({ ...structuredClone(snap.tabs[0]!), tab_id: `${id}:t1`, workspace_id: id, label: spec.label, number: 1, agent_status: pane.agent_status, focused: false, pane_count: 1 });
    snap.workspaces.push({ ...structuredClone(template), workspace_id: id, label: spec.label, number: snap.workspaces.length + 1, active_tab_id: `${id}:t1`, agent_status: pane.agent_status, focused: false, pane_count: 1, tab_count: 1 });
    addDemoLayout(id, `${id}:t1`, pane.pane_id);
    keyOfPane.set(pane.pane_id, spec.key);
  }
  // the fixture's own order is kept; a backfilled pane joins at the end of the list
  snap.workspaces.forEach((workspace, index) => { workspace.number = index + 1; });
}
backfillPanes();
for (const pane of snapshot().panes) if (keyOfPane.get(pane.pane_id) === OMO_TASKS_PANE) Object.assign(pane, { background_tasks: 2 });
for (const pane of snapshot().panes) if (keyOfPane.get(pane.pane_id) === "api") Object.assign(pane, { plan: { done: 1, total: planSteps.length, current: "Adding the replay metric" } });

// Fictional repositories keep their checkout catalog after a workspace closes. The list joins
// each checkout to the current snapshot, so closed checkouts can be opened again without git.
interface DemoRepository {
  repoKey: string;
  repoName: string;
  repoRoot: string;
  branches: Set<string>;
  checkouts: Array<Omit<WorktreeEntry, "open_workspace_id">>;
}
const repositories = new Map<string, DemoRepository>();
function repositoryAt(path: string): DemoRepository {
  const repoKey = `demo:${path}`;
  let repo = repositories.get(repoKey);
  if (!repo) {
    repo = { repoKey, repoName: path.split("/").filter(Boolean).pop() ?? "project", repoRoot: path, branches: new Set(["main"]), checkouts: [{ path, branch: "main", label: "main", is_linked_worktree: false, is_bare: false, is_detached: false, is_prunable: false }] };
    repositories.set(repoKey, repo);
  }
  return repo;
}
function worktreeMetadata(repo: DemoRepository, path = repo.repoRoot): NonNullable<WorkspaceInfo["worktree"]> {
  return { repo_key: repo.repoKey, repo_name: repo.repoName, repo_root: repo.repoRoot, checkout_path: path, is_linked_worktree: path !== repo.repoRoot };
}
for (const workspace of snapshot().workspaces) {
  const cwd = snapshot().panes.find((pane) => pane.workspace_id === workspace.workspace_id)?.cwd;
  if (cwd) workspace.worktree = worktreeMetadata(repositoryAt(cwd));
}
// The last workspace can be closed in a demo, so creation keeps templates independent of it.
const newPaneTemplate = structuredClone(snapshot().panes[0]!);
const newTabTemplate = structuredClone(snapshot().tabs[0]!);
const newWorkspaceTemplate = structuredClone(snapshot().workspaces[0]!);

function createDemoWorkspace(cwd: string, label: string, agent: string | null, worktree?: NonNullable<WorkspaceInfo["worktree"]>): WorkspaceCreated {
  const id = `w${(nextWorkspace++).toString(36)}`;
  const snap = snapshot();
  const pane: Pane = { ...structuredClone(newPaneTemplate), pane_id: `${id}:p1`, tab_id: `${id}:t1`, terminal_id: `${id}:term`, workspace_id: id, label: null, title: null, agent, agent_session: null, agent_status: agent ? "working" : "unknown", cwd, foreground_cwd: cwd, focused: false, terminal_title: null, terminal_title_stripped: null, revision: 1 };
  snap.panes.push(pane);
  addAgent(pane);
  snap.tabs.push({ ...structuredClone(newTabTemplate), tab_id: `${id}:t1`, workspace_id: id, label, number: 1, agent_status: pane.agent_status, focused: false, pane_count: 1 });
  snap.workspaces.push({ ...structuredClone(newWorkspaceTemplate), workspace_id: id, label, number: snap.workspaces.length + 1, active_tab_id: `${id}:t1`, agent_status: pane.agent_status, focused: false, pane_count: 1, tab_count: 1, worktree: worktree ?? worktreeMetadata(repositoryAt(cwd)) });
  addDemoLayout(id, `${id}:t1`, pane.pane_id);
  if (agent) {
    keyOfPane.set(pane.pane_id, pane.pane_id);
    chats.set(pane.pane_id, { turns: [], metadata: { model: agent === "codex" ? "gpt-5.6-sol" : "claude-opus-5-5", reasoning_effort: "medium" } });
    conversationChanged(pane.pane_id);
    setTimeout(() => { if (!replying.has(pane.pane_id)) finishDemoTurn(pane.pane_id, "idle"); }, 1500);
  }
  return { workspace_id: id, pane_id: pane.pane_id, agent_started: agent !== null };
}

function closeDemoWorkspaces(ids: Set<string>): void {
  const snap = snapshot();
  for (const removed of snap.panes.filter((pane) => ids.has(pane.workspace_id))) {
    for (const socket of sockets) socket.holdPending(removed.pane_id, "pane_not_found", "This demo pane closed. Copy the message before discarding it.");
    replying.delete(removed.pane_id);
  }
  snap.panes = snap.panes.filter((pane) => !ids.has(pane.workspace_id));
  snap.tabs = snap.tabs.filter((tab) => !ids.has(tab.workspace_id));
  snap.workspaces = snap.workspaces.filter((workspace) => !ids.has(workspace.workspace_id));
  const paneIds = new Set(snap.panes.map((pane) => pane.pane_id));
  snap.agents = snap.agents.filter((agent) => paneIds.has(agent.pane_id));
  snap.layouts = snap.layouts.filter((layout) => !ids.has(layout.workspace_id));
  const focused = snap.panes.find((pane) => pane.pane_id === snap.focused_pane_id) ?? snap.panes[0];
  snap.focused_pane_id = focused?.pane_id ?? null;
  snap.focused_tab_id = focused?.tab_id ?? null;
  snap.focused_workspace_id = focused?.workspace_id ?? null;
  for (const pane of snap.panes) pane.focused = pane.pane_id === snap.focused_pane_id;
  for (const tab of snap.tabs) tab.focused = tab.tab_id === snap.focused_tab_id;
  snap.workspaces.forEach((workspace, index) => { workspace.number = index + 1; workspace.focused = workspace.workspace_id === snap.focused_workspace_id; });
}

const sseListeners = new Set<SseListener>();
const sockets = new Set<DemoSocket>();
const conversationVersions = new Map<string, number>();

// herdr names an unnamed tab by its place in the row and moves that name up when an earlier tab
// closes; a renamed tab keeps its name. The demo tracks which tabs still carry the automatic name.
const autoTabs = new Set<string>();
function relabelAutoTabs(workspaceId: string): void {
  // a tab that is gone is forgotten, so a later tab given its ID keeps the name it was created with
  const live = new Set(snapshot().tabs.map((tab) => tab.tab_id));
  for (const id of autoTabs) if (!live.has(id)) autoTabs.delete(id);
  let place = 0;
  for (const tab of snapshot().tabs) {
    if (tab.workspace_id !== workspaceId) continue;
    place += 1;
    if (autoTabs.has(tab.tab_id)) tab.label = String(place);
  }
}

function recountDemoWorkspace(workspaceId: string): void {
  const snap = snapshot();
  const workspace = snap.workspaces.find((candidate) => candidate.workspace_id === workspaceId);
  if (!workspace) return;
  const panes = snap.panes.filter((pane) => pane.workspace_id === workspaceId);
  const tabs = snap.tabs.filter((tab) => tab.workspace_id === workspaceId);
  for (const tab of tabs) {
    const own = panes.filter((pane) => pane.tab_id === tab.tab_id);
    tab.pane_count = own.length;
    tab.agent_status = rollupStatus(own.map((pane) => pane.agent_status));
  }
  workspace.pane_count = panes.length;
  workspace.tab_count = tabs.length;
  workspace.agent_status = rollupStatus(panes.map((pane) => pane.agent_status));
  if (!tabs.some((tab) => tab.tab_id === workspace.active_tab_id)) workspace.active_tab_id = tabs[0]?.tab_id ?? workspace.active_tab_id;
}

/** a tab's layout as herdr reports one: the fixture's where it has one, else its panes side by side */
function demoLayout(tabId: string): Layout {
  const snap = snapshot();
  const existing = snap.layouts.find((layout) => layout.tab_id === tabId);
  if (existing) return existing;
  const own = snap.panes.filter((pane) => pane.tab_id === tabId);
  const width = Math.floor(120 / Math.max(1, own.length));
  return {
    workspace_id: own[0]?.workspace_id ?? "", tab_id: tabId, zoomed: false, area: { x: 0, y: 0, width: 120, height: 40 },
    focused_pane_id: own.find((pane) => pane.focused)?.pane_id ?? own[0]?.pane_id ?? "",
    panes: own.map((pane, index) => ({ pane_id: pane.pane_id, focused: pane.focused, rect: { x: index * width, y: 0, width, height: 40 } })),
    splits: [],
  };
}

// herdr's `pane move`: the pane into another tab, a new tab or a new workspace, under a new id
// when it leaves its workspace; the tab and workspace it emptied close behind it
function moveDemoPane(pane: Pane, destination: Record<string, unknown>, focus = false): PaneMoved | Response {
  const snap = snapshot();
  const previous = { pane_id: pane.pane_id, workspace_id: pane.workspace_id, tab_id: pane.tab_id };
  const makeTab = (workspaceId: string, label: string): Tab => {
    const number = Math.max(0, ...snap.tabs.filter((tab) => tab.workspace_id === workspaceId).map((tab) => tab.number)) + 1;
    const tab: Tab = { ...structuredClone(newTabTemplate), tab_id: `${workspaceId}:t${number}`, workspace_id: workspaceId, label, number, agent_status: pane.agent_status, focused: false, pane_count: 0 };
    snap.tabs.push(tab);
    if (label === "") autoTabs.add(tab.tab_id); else autoTabs.delete(tab.tab_id);
    return tab;
  };
  let targetTab: Tab;
  let createdTab: Tab | null = null;
  let createdWorkspace: WorkspaceInfo | null = null;
  switch (destination["type"]) {
    case "tab": {
      const tab = snap.tabs.find((candidate) => candidate.tab_id === destination["tab_id"]);
      if (!tab) return error("tab_not_found", "no such tab", 404);
      if (tab.tab_id === pane.tab_id) {
        return { changed: false, reason: "same_tab", previous_pane_id: pane.pane_id, previous_workspace_id: pane.workspace_id, previous_tab_id: pane.tab_id, pane, focused_pane_id: snap.focused_pane_id ?? pane.pane_id, target_layout: demoLayout(tab.tab_id) };
      }
      targetTab = tab;
      break;
    }
    case "new_tab": {
      const workspace = snap.workspaces.find((candidate) => candidate.workspace_id === (destination["workspace_id"] ?? pane.workspace_id));
      if (!workspace) return error("workspace_not_found", "no such workspace", 404);
      targetTab = createdTab = makeTab(workspace.workspace_id, String(destination["label"] ?? ""));
      break;
    }
    case "new_workspace": {
      const id = `w${(nextWorkspace++).toString(36)}`;
      const cwd = pane.cwd ?? pane.foreground_cwd ?? "/home/demo";
      const label = String(destination["label"] ?? "") || cwd.split("/").pop() || id;
      createdWorkspace = { ...structuredClone(newWorkspaceTemplate), workspace_id: id, label, number: snap.workspaces.length + 1, active_tab_id: `${id}:t1`, agent_status: pane.agent_status, focused: false, pane_count: 0, tab_count: 1, worktree: worktreeMetadata(repositoryAt(cwd)) };
      snap.workspaces.push(createdWorkspace);
      targetTab = createdTab = makeTab(id, String(destination["tab_label"] ?? ""));
      break;
    }
    default:
      return error("invalid_destination", "destination.type must be \"tab\", \"new_tab\" or \"new_workspace\"", 400);
  }
  const crossing = targetTab.workspace_id !== previous.workspace_id;
  const paneId = crossing ? `${targetTab.workspace_id}:p${(nextWorkspace++).toString(36)}` : pane.pane_id;
  const target = snap.layouts.find((layout) => layout.tab_id === targetTab.tab_id);
  if (target) {
    const beside = target.panes.find((candidate) => candidate.pane_id === (destination["target_pane_id"] ?? target.focused_pane_id)) ?? target.panes.at(-1);
    if (!beside || !splitLayout(target, beside.pane_id, { pane_id: paneId, focused: false, rect: beside.rect }, destination["split"] === "down" ? "down" : "right")) {
      return error("split_failed", "The demo pane is too small to split.", 400);
    }
  } else addDemoLayout(targetTab.workspace_id, targetTab.tab_id, paneId);
  if (crossing) {
    movedPaneIds.set(previous.pane_id, paneId);
    const key = keyOfPane.get(previous.pane_id);
    if (key !== undefined) { keyOfPane.delete(previous.pane_id); keyOfPane.set(paneId, key); }
    if (replying.delete(previous.pane_id)) replying.add(paneId);
    for (const agent of snap.agents) if (agent.pane_id === previous.pane_id) agent.pane_id = paneId;
    for (const socket of sockets) socket.holdPending(previous.pane_id, "pane_not_found", "This demo pane moved to another workspace. Copy the message before discarding it.");
  }
  pane.pane_id = paneId;
  pane.workspace_id = targetTab.workspace_id;
  pane.tab_id = targetTab.tab_id;
  const source = snap.layouts.find((layout) => layout.tab_id === previous.tab_id);
  if (source) {
    closeLayoutPane(source, previous.pane_id);
    if (source.focused_pane_id === previous.pane_id) source.focused_pane_id = source.panes[0]?.pane_id ?? "";
    for (const candidate of source.panes) candidate.focused = candidate.pane_id === source.focused_pane_id;
  }
  let closedTabId: string | null = null;
  let closedWorkspaceId: string | null = null;
  if (!snap.panes.some((candidate) => candidate.tab_id === previous.tab_id)) {
    closedTabId = previous.tab_id;
    snap.tabs = snap.tabs.filter((tab) => tab.tab_id !== previous.tab_id);
    autoTabs.delete(previous.tab_id);
    snap.layouts = snap.layouts.filter((layout) => layout.tab_id !== previous.tab_id);
    if (!snap.tabs.some((tab) => tab.workspace_id === previous.workspace_id)) {
      closedWorkspaceId = previous.workspace_id;
      snap.workspaces = snap.workspaces.filter((workspace) => workspace.workspace_id !== previous.workspace_id);
    }
  }
  relabelAutoTabs(previous.workspace_id);
  relabelAutoTabs(targetTab.workspace_id);
  recountDemoWorkspace(previous.workspace_id);
  recountDemoWorkspace(targetTab.workspace_id);
  if (focus) {
    snap.focused_pane_id = paneId;
    snap.focused_tab_id = targetTab.tab_id;
    snap.focused_workspace_id = targetTab.workspace_id;
  } else {
    // focus was not asked to follow, but it cannot stay on a tab or workspace that closed behind
    // the pane: a pane still there takes it, one outside the destination when there is one
    if (snap.focused_pane_id === previous.pane_id || !snap.tabs.some((tab) => tab.tab_id === snap.focused_tab_id) || !snap.workspaces.some((workspace) => workspace.workspace_id === snap.focused_workspace_id)) {
      const heir = snap.panes.find((candidate) => candidate.pane_id === source?.focused_pane_id)
        ?? snap.panes.find((candidate) => candidate.workspace_id === previous.workspace_id && candidate.pane_id !== paneId)
        ?? snap.panes.find((candidate) => candidate.workspace_id !== targetTab.workspace_id)
        ?? pane;
      snap.focused_pane_id = heir.pane_id;
      snap.focused_tab_id = heir.tab_id;
      snap.focused_workspace_id = heir.workspace_id;
    }
  }
  for (const candidate of snap.panes) candidate.focused = candidate.pane_id === snap.focused_pane_id;
  for (const tab of snap.tabs) tab.focused = tab.tab_id === snap.focused_tab_id;
  snap.workspaces.forEach((workspace, index) => { workspace.number = index + 1; workspace.focused = workspace.workspace_id === snap.focused_workspace_id; });
  const focused = snap.panes.find((candidate) => candidate.pane_id === snap.focused_pane_id);
  if (focused) focusDemoPane(focused);
  return {
    changed: true, previous_pane_id: previous.pane_id, previous_workspace_id: previous.workspace_id, previous_tab_id: previous.tab_id, pane,
    created_tab: createdTab, created_workspace: createdWorkspace, closed_tab_id: closedTabId, closed_workspace_id: closedWorkspaceId,
    focused_pane_id: snap.focused_pane_id ?? paneId, target_layout: demoLayout(targetTab.tab_id),
  };
}

function emitSse(event: MachineEvent): void {
  const message = new MessageEvent("message", { data: JSON.stringify(event) });
  for (const listener of sseListeners) listener(message);
}

function paneOf(paneId: string): Pane | undefined {
  return snapshot().panes.find((pane) => pane.pane_id === paneId);
}

function setStatus(paneId: string, status: AgentStatus): void {
  const pane = paneOf(paneId);
  if (!pane) return;
  pane.agent_status = status;
  // as herdr does, every state change bumps the session's counter on the pane's agent
  const agent = snapshot().agents.find((entry) => entry.pane_id === paneId);
  if (agent) Object.assign(agent, { agent_status: status, state_change_seq: nextStateSeq() });
  for (const workspace of snapshot().workspaces) if (workspace.workspace_id === pane.workspace_id) workspace.agent_status = status;
  for (const tab of snapshot().tabs) if (tab.tab_id === pane.tab_id) tab.agent_status = status;
  emitSse({ type: "machine-message", machine_id: local.id, message: { type: "pane-status", pane_id: paneId, agent_status: status } });
  for (const socket of sockets) socket.push({ type: "pane-status", pane_id: paneId, agent_status: status });
}

function conversationChanged(paneId: string): void {
  const revision = (conversationVersions.get(paneId) ?? 0) + 1;
  conversationVersions.set(paneId, revision);
  for (const socket of sockets) socket.push({ type: "conversation-changed", pane_id: paneId, signature: `demo:${revision}` });
}

function structureChanged(): void {
  emitSse({ type: "machines", machines });
  emitSse({ type: "machine-message", machine_id: local.id, message: { type: "session-changed" } });
  for (const socket of sockets) socket.push({ type: "session-changed" });
}

/** A click in herdr focuses the pane, its tab and its workspace while preserving other tabs' own focus. */
function focusDemoPane(pane: Pane): void {
  const snap = snapshot();
  snap.focused_pane_id = pane.pane_id;
  snap.focused_tab_id = pane.tab_id;
  snap.focused_workspace_id = pane.workspace_id;
  const layout = snap.layouts.find((candidate) => candidate.tab_id === pane.tab_id);
  if (layout) {
    layout.focused_pane_id = pane.pane_id;
    for (const candidate of layout.panes) candidate.focused = candidate.pane_id === pane.pane_id;
  }
  for (const candidate of snap.panes) candidate.focused = candidate.pane_id === pane.pane_id;
  for (const tab of snap.tabs) tab.focused = tab.tab_id === pane.tab_id;
  for (const workspace of snap.workspaces) {
    workspace.focused = workspace.workspace_id === pane.workspace_id;
    if (workspace.focused) workspace.active_tab_id = pane.tab_id;
  }
}

function agentOf(paneId: string): string {
  const key = keyOfPane.get(paneId);
  return SPECS.find((spec) => spec.key === key)?.agent ?? paneOf(paneId)?.agent ?? "the agent";
}

const now = () => new Date().toISOString();

/** the id a pane answers to after a move took it to another workspace, for a mock turn begun under the old one */
const movedPaneIds = new Map<string, string>();

/** The bridge takes one accepted pending message when the current mock turn finishes. */
function finishDemoTurn(paneId: string, status: "idle" | "done" = "done"): void {
  while (movedPaneIds.has(paneId)) paneId = movedPaneIds.get(paneId)!;
  replying.delete(paneId);
  if (!paneOf(paneId)) return;
  setStatus(paneId, status);
  for (const socket of [...sockets].sort((a, b) => a.pendingOrder(paneId) - b.pendingOrder(paneId))) {
    if (socket.drainPending(paneId)) break;
  }
}

/** A sent Enter joins the conversation now; another Enter steers the current mock turn. */
function submitToChat(paneId: string, text: string): void {
  const key = keyOfPane.get(paneId);
  const chat = key ? chats.get(key) : undefined;
  if (!chat) return;
  chat.turns.push({ role: "user", ts: now(), parts: [{ kind: "text", text }] });
  conversationChanged(paneId);
  const agent = agentOf(paneId);
  if (replying.has(paneId)) return;
  replying.add(paneId);
  setStatus(paneId, "working");
  setTimeout(() => {
    chat.turns.push({ role: "assistant", ts: now(), end_ts: now(), parts: [{ kind: "text", text: `This is the demo, so nothing ran. In the real app that message went to ${agent} in this pane, and its answer would be written here as it arrives, with its commands and edits folded above it.` }] });
    conversationChanged(paneId);
    finishDemoTurn(paneId);
  }, CHAT_ANSWER_MS);
}

function answerPrompt(paneId: string, optionIndex: number | undefined): void {
  promptOpen = false;
  replying.add(paneId);
  setStatus(paneId, "working");
  const chat = chats.get("web");
  const declined = optionIndex === 2;
  setTimeout(() => {
    chat?.turns.push({
      role: "assistant", ts: now(), end_ts: now(),
      parts: declined
        ? [{ kind: "text", text: "Understood, I won't push. The changes stay on `feat/export-guard` locally; tell me what to do differently." }]
        : [{ kind: "tool", name: "exec", summary: "git push origin feat/export-guard", input: JSON.stringify({ cmd: "git push origin feat/export-guard" }, null, 2), output: "To github.com:acme/web-dashboard.git\n * [new branch]      feat/export-guard -> feat/export-guard" },
          { kind: "text", text: "Pushed `feat/export-guard`. The export button is guarded and the branch is ready for a pull request." }],
    });
    if (chat) conversationChanged(paneId);
    finishDemoTurn(paneId);
  }, PROMPT_ANSWER_TURN_MS);
}

// ---- HTTP -------------------------------------------------------------------------------------

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });
const error = (code: string, message: string, status: number) => json({ error: { code, message } }, status);

async function bodyOf(init: RequestInit | undefined, input: RequestInfo | URL): Promise<Record<string, unknown>> {
  try {
    if (init?.body) return JSON.parse(String(init.body)) as Record<string, unknown>;
    if (input instanceof Request) return (await input.clone().json()) as Record<string, unknown>;
  } catch { /* not JSON */ }
  return {};
}

async function layoutBodyOf(method: string, init: RequestInit | undefined, input: RequestInfo | URL): Promise<Record<string, unknown> | Response> {
  if (method !== "POST") return error("method_not_allowed", "use POST", 400);
  let body: unknown;
  try { body = init?.body ? JSON.parse(String(init.body)) : input instanceof Request ? await input.clone().json() : undefined; }
  catch { return error("invalid_json", "request body must be JSON", 400); }
  if (body === undefined) return error("invalid_json", "request body must be JSON", 400);
  if (body === null || typeof body !== "object" || Array.isArray(body)) return error("invalid_body", "request body must be a JSON object", 400);
  return body as Record<string, unknown>;
}

const DEMO_FILES = ["src/routes/payments.ts", "src/lib/idempotency.ts", "src/metrics.ts", "src/pages/Reports.tsx", "src/money.ts", "src/money.test.ts", "package.json", "README.md"];

/** Settings → Subscription usage on the demo: plans as the workstation's CLIs might report them, resets counted from now. */
function usageReport(): UsageReport {
  const now = Date.now();
  const at = (hours: number) => new Date(now + hours * 3_600_000).toISOString();
  // Claude and Codex state a window's length (5 h, 7 days), so the server knows when it began; the others do not
  const session = (hours: number) => ({ resets_at: at(hours), starts_at: at(hours - 5) });
  const week = (hours: number) => ({ resets_at: at(hours), starts_at: at(hours - 168) });
  const checked = new Date(now).toISOString();
  return { providers: [
    { id: "claude", key: "claude:demo-claude", account: "sam@example.com", plan: "max", problem: null, checked_at: checked, windows: [
      { kind: "session", scope: null, used_percent: 38, ...session(2.4) },
      { kind: "week", scope: null, used_percent: 61, ...week(78) },
      { kind: "week", scope: "Sonnet", used_percent: 12, ...week(78) },
    ] },
    { id: "codex", key: "codex:demo-codex-work", account: "sam@work.example", plan: "pro", problem: null, checked_at: checked, windows: [
      { kind: "session", scope: null, used_percent: 22, ...session(1.2) },
      { kind: "week", scope: null, used_percent: 84, ...week(97) },
    ] },
    { id: "codex", key: "codex:demo-codex-home", account: "sam@example.com", plan: "plus", problem: null, checked_at: checked, windows: [
      { kind: "session", scope: null, used_percent: 5, ...session(3.1) },
      { kind: "week", scope: null, used_percent: 31, ...week(140) },
    ] },
    { id: "cursor", key: "cursor:demo-cursor", account: "sam@example.com", plan: "pro", problem: null, checked_at: checked, windows: [
      { kind: "month", scope: null, used_percent: 27, resets_at: at(290), starts_at: null },
      { kind: "month", scope: "Cursor models", used_percent: 19, resets_at: at(290), starts_at: null },
      { kind: "month", scope: "Other models", used_percent: 8, resets_at: at(290), starts_at: null },
    ] },
    { id: "opencode", key: "opencode:demo-opencode", account: null, plan: "Go", problem: null, checked_at: checked, windows: [
      { kind: "session", scope: null, used_percent: 10, resets_at: at(3.2), starts_at: null },
      { kind: "week", scope: null, used_percent: 28, resets_at: at(18), starts_at: null },
      { kind: "month", scope: null, used_percent: 15, resets_at: at(520), starts_at: null },
    ] },
  ] };
}

/** One fictional plugin, so the palette's Plugin actions group and Settings have something to show. */
const PLUGINS: PluginActions[] = [
  { plugin_id: "example.layout", name: "Layout", version: "0.1.0", description: "Apply project layouts", enabled: true, actions: [
    { action_id: "apply", title: "Apply layout", description: "Arrange this workspace's panes", contexts: ["workspace"] },
    { action_id: "save", title: "Save layout", description: null, contexts: ["workspace"] },
  ] },
];

async function route(url: URL, method: string, init: RequestInit | undefined, input: RequestInfo | URL): Promise<Response> {
  const path = url.pathname;
  // Includes Human Review discussion, approval and Decline: the demo explains Machine unavailability.
