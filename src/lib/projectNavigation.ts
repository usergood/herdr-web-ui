import { nativeSessionRef } from "../../shared/native-pane.ts";
import type { FactoryOverview, FactoryPaneLink } from "../../shared/factory.ts";
import type { HerdrPane } from "../../shared/protocol.ts";
import { paneStorageId, type Machine } from "../../shared/machines.ts";

export type ProjectView = { kind: "projects" | "assignments" } | { kind: "project" | "project-inbox" | "project-settings"; id: string } | { kind: "assignment"; id: string; conversationId?: string } | { kind: "inbox" };
export function projectView(hash: string): ProjectView {
  if (hash === "#assignments") return { kind: "assignments" };
  const project = /^#projects(?:\/([a-zA-Z0-9-]+)(\/(?:inbox|settings))?)?$/.exec(hash);
  if (project) return project[1] ? { kind: project[2] === "/settings" ? "project-settings" : project[2] ? "project-inbox" : "project", id: project[1] } : { kind: "projects" };
  const assignment = /^#factory\/([a-zA-Z0-9-]+)(?:\?conversation=([^&]+))?$/.exec(hash);
  if (assignment) {
    try { return { kind: "assignment", id: assignment[1]!, ...(assignment[2] ? { conversationId: decodeURIComponent(assignment[2]) } : {}) }; }
    catch { return { kind: "assignment", id: assignment[1]! }; }
  }
  return { kind: "inbox" };
}
export function projectHash(view: ProjectView): string {
  return view.kind === "assignments" ? "#assignments" : view.kind === "projects" ? "#projects" : view.kind === "project-settings" ? `#projects/${view.id}/settings` : view.kind === "project" ? `#projects/${view.id}` : view.kind === "project-inbox" ? `#projects/${view.id}/inbox` : view.kind === "assignment" ? `#factory/${view.id}${view.conversationId ? `?conversation=${encodeURIComponent(view.conversationId)}` : ""}` : "#factory";
}
function normalized(path: string): string {
  const value = path.replaceAll("\\", "/").replace(/\/+$/, "") || "/";
  return /^[A-Za-z]:\//.test(value) ? value.toLowerCase() : value;
}
export interface ProjectPane { machine: Machine; pane: HerdrPane; projectId: string; link: FactoryPaneLink | null; archived: boolean }
/** Explicit factory provenance also covers isolated worktrees outside the checkout. */
export function projectPanes(overview: FactoryOverview, machines: Machine[]): ProjectPane[] {
  const projects = new Map(overview.projects.filter((p) => !p.removed_at).map((p) => [p.id, p]));
  const ideas = new Map(overview.implementations.map((i) => [i.id, i]));
  const links = new Map((overview.pane_links ?? []).map((l) => [paneStorageId(l.machine_id, l.pane_id), l]));
  const archives = archivedPaneKeys(overview, machines);
  return machines.flatMap((machine) => (machine.snapshot?.panes ?? []).flatMap((pane) => {
    const key = paneStorageId(machine.id, pane.pane_id); const candidate = links.get(key); const link = candidate?.workspace_id === pane.workspace_id && candidate.worktree && normalized(candidate.worktree) === normalized(pane.cwd ?? "") ? candidate : null;
    const assignment = link ? ideas.get(link.implementation_id) : null;
    const rawCwd = pane.foreground_cwd || pane.cwd; const cwd = rawCwd ? normalized(rawCwd) : "";
    const checkout = overview.checkouts.filter((c) => projects.has(c.project_id) && c.machine_id === machine.id && (cwd === normalized(c.path) || (normalized(c.path) === "/" ? cwd.startsWith("/") : cwd.startsWith(`${normalized(c.path)}/`)))).sort((a, b) => b.path.length - a.path.length)[0];
    const linkedProjectId = link?.project_id === undefined ? assignment?.project_id : link.project_id;
    const projectId = linkedProjectId && projects.has(linkedProjectId) ? linkedProjectId : checkout?.project_id;
    return projectId ? [{ machine, pane, projectId, link: linkedProjectId === projectId ? link : null, archived: !!assignment?.archived_at || archives.has(key) }] : [];
  }));
}

/** Pane ids can be reused. An archive belongs to the native terminal it captured. */
export function archivedPaneKeys(overview: FactoryOverview, machines: Machine[]): Set<string> {
  return new Set((overview.pane_archives ?? []).filter((archive) => archive.archived_at && archive.terminal_id && machines.find((m) => m.id === archive.machine_id)?.snapshot?.panes.some((p) => p.pane_id === archive.pane_id && p.terminal_id === archive.terminal_id && nativeSessionRef(p) === archive.session_ref)).map((a) => paneStorageId(a.machine_id, a.pane_id)));
}
