import type { FactoryOverview, FactoryPaneLink } from "../../shared/factory.ts";
import type { HerdrPane } from "../../shared/protocol.ts";
import { paneStorageId, type Machine } from "../../shared/machines.ts";

export type ProjectView = { kind: "projects" } | { kind: "project" | "project-inbox" | "assignment"; id: string } | { kind: "inbox" };
export function projectView(hash: string): ProjectView {
  const project = /^#projects(?:\/([a-zA-Z0-9-]+)(\/inbox)?)?$/.exec(hash);
  if (project) return project[1] ? { kind: project[2] ? "project-inbox" : "project", id: project[1] } : { kind: "projects" };
  const assignment = /^#factory\/([a-zA-Z0-9-]+)$/.exec(hash);
  return assignment ? { kind: "assignment", id: assignment[1]! } : { kind: "inbox" };
}
export function projectHash(view: ProjectView): string {
  return view.kind === "projects" ? "#projects" : view.kind === "project" ? `#projects/${view.id}` : view.kind === "project-inbox" ? `#projects/${view.id}/inbox` : view.kind === "assignment" ? `#factory/${view.id}` : "#factory";
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
  const archives = new Set((overview.pane_archives ?? []).filter((a) => a.archived_at).map((a) => paneStorageId(a.machine_id, a.pane_id)));
  return machines.flatMap((machine) => (machine.snapshot?.panes ?? []).flatMap((pane) => {
    const key = paneStorageId(machine.id, pane.pane_id); const link = links.get(key) ?? null;
    const assignment = link ? ideas.get(link.implementation_id) : null;
    const cwd = normalized(pane.foreground_cwd || pane.cwd || "");
    const checkout = overview.checkouts.filter((c) => projects.has(c.project_id) && c.machine_id === machine.id && (cwd === normalized(c.path) || (normalized(c.path) === "/" ? cwd.startsWith("/") : cwd.startsWith(`${normalized(c.path)}/`)))).sort((a, b) => b.path.length - a.path.length)[0];
    const projectId = assignment?.project_id && projects.has(assignment.project_id) ? assignment.project_id : checkout?.project_id;
    return projectId ? [{ machine, pane, projectId, link: assignment?.project_id === projectId ? link : null, archived: !!assignment?.archived_at || archives.has(key) }] : [];
  }));
}
/** Only sidebar snapshots are filtered. The original native topology still drives the canvas. */
export function remainingMachines(machines: Machine[], claimed: Set<string>): Machine[] {
  return machines.map((machine) => {
    if (!machine.snapshot) return machine;
    const panes = machine.snapshot.panes.filter((pane) => !claimed.has(paneStorageId(machine.id, pane.pane_id)));
    const workspaces = new Set(panes.map((p) => p.workspace_id)); const tabs = new Set(panes.map((p) => p.tab_id));
    return { ...machine, snapshot: { ...machine.snapshot, panes, workspaces: machine.snapshot.workspaces.filter((w) => workspaces.has(w.workspace_id)), tabs: machine.snapshot.tabs.filter((tab) => tabs.has(tab.tab_id)), agents: machine.snapshot.agents.filter((a) => panes.some((p) => p.pane_id === a.pane_id)) } };
  });
}
