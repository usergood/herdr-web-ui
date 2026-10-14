import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { FactoryChat, FactoryMessage, FactoryProject, Implementation } from "../shared/factory.ts";
import type { ProjectUpstreamOverview, UpstreamRelease } from "../shared/upstream-releases.ts";
import { FactoryError } from "./factory-host.ts";
import { FactoryStore } from "./factory-store.ts";

interface StoredUpstream extends ProjectUpstreamOverview { id: string; offered: string[] }

/** Release discovery only creates Inbox work; execution retains the normal approval gates. */
export class UpstreamReleases {
  constructor(private readonly store: FactoryStore) {
    for (const project of store.list<FactoryProject>("projects")) if (!project.removed_at) this.reconcile(project);
  }
  overview(projectId: string, repository: string | null): ProjectUpstreamOverview {
    const saved = this.store.get<StoredUpstream>("upstream_releases", projectId);
    if (!saved) return { repository, detected: null, active: null, candidate: null };
    const { id: _, offered: __, ...view } = saved;
    return view;
  }
  configure(projectId: string, repository: string | null): void {
    const state = this.store.get<StoredUpstream>("upstream_releases", projectId);
    if (!state || state.repository?.toLowerCase() === repository?.toLowerCase()) return;
    if (state.active) throw new FactoryError("upstream_update_pending", "Finish or discard the pending upstream update before changing its repository", 409);
    this.store.put<StoredUpstream>("upstream_releases", { id: projectId, repository, detected: null, active: null, candidate: null, offered: state.offered }, projectId);
  }
  reconcile(project: FactoryProject): void {
    const state = this.store.get<StoredUpstream>("upstream_releases", project.id);
    if (!state?.active) return;
    const idea = this.store.get<Implementation>("implementations", state.active.implementation_id);
    if (!idea || !(idea.stage === "done" && idea.outcome === "discarded" || idea.delivery?.condition === "merged")) return;
    this.store.db.transaction(() => {
      const active = state.candidate ? this.createAssignment(project, state.candidate) : null;
      const offered = active ? [...state.offered, this.identity(active.release)] : state.offered;
      this.store.put<StoredUpstream>("upstream_releases", { ...state, active, candidate: null, offered }, project.id);
    })();
  }
  private identity(release: UpstreamRelease): string { return `${release.repository.toLowerCase()}:${release.release_id}`; }
  private newer(a: UpstreamRelease, b: UpstreamRelease): boolean {
    return Date.parse(a.published_at) > Date.parse(b.published_at) || Date.parse(a.published_at) === Date.parse(b.published_at) && Number(a.release_id) > Number(b.release_id);
  }
  async synchronize(project: FactoryProject, repository: string, api: (path: string) => Promise<unknown>): Promise<void> {
    const releases: { id: number; tag_name: string; published_at: string }[] = [];
    for (let page = 1; page <= 100; page++) {
      const rows = await api(`repos/${repository}/releases?per_page=30&page=${page}`);
      if (!Array.isArray(rows)) throw new FactoryError("github_invalid_response", "GitHub did not return upstream releases", 409);
      for (const row of rows) {
        if (!row || typeof row.draft !== "boolean") throw new FactoryError("github_invalid_response", "GitHub returned an invalid upstream release", 409);
        if (row.draft) continue;
        if (!Number.isSafeInteger(row.id) || row.id <= 0 || typeof row.tag_name !== "string" || !row.tag_name || row.tag_name.length > 200 || /[\s\0-\x1f\x7f]/.test(row.tag_name) || typeof row.published_at !== "string" || !Number.isFinite(Date.parse(row.published_at))) throw new FactoryError("github_invalid_response", "GitHub returned an invalid upstream release", 409);
        releases.push(row);
      }
      if (rows.length < 30) break;
      if (page === 100) throw new FactoryError("github_inventory_limit", "Upstream releases exceed the bounded synchronization budget", 409);
    }
    const latest = releases.sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at) || b.id - a.id)[0];
    if (!latest) return;
    const commit = await api(`repos/${repository}/commits/${encodeURIComponent(latest.tag_name)}`) as { sha?: string };
    if (!commit || typeof commit.sha !== "string" || !/^[0-9a-f]{40,64}$/.test(commit.sha)) throw new FactoryError("github_invalid_response", "GitHub did not resolve the upstream release commit", 409);
    const release: UpstreamRelease = { repository, release_id: String(latest.id), tag: latest.tag_name, revision: commit.sha, published_at: latest.published_at, url: `https://github.com/${repository}/releases/tag/${encodeURIComponent(latest.tag_name)}` };
    const view = this.overview(project.id, repository);
    this.store.db.transaction(() => {
      const offered = this.store.get<StoredUpstream>("upstream_releases", project.id)?.offered ?? [];
      const applicable = !offered.includes(this.identity(release)) && (!view.detected || this.newer(release, view.detected));
      const active = view.active ?? (applicable ? this.createAssignment(project, release) : null);
      const candidate = active && release.release_id !== active.release.release_id && applicable && (!view.candidate || this.newer(release, view.candidate)) ? release : view.candidate;
      if (active && !offered.includes(this.identity(active.release))) offered.push(this.identity(active.release));
      const detected = view.detected && !this.newer(release, view.detected) ? view.detected : release;
      this.store.put<StoredUpstream>("upstream_releases", { id: project.id, repository, detected, active, candidate, offered }, project.id);
    })();
    this.reconcile(project);
  }
  private createAssignment(project: FactoryProject, release: UpstreamRelease): NonNullable<ProjectUpstreamOverview["active"]> {
    const description = `Plan an upstream update from ${release.repository}.\nRelease: ${release.tag} (${release.release_id})\nCommit: ${release.revision}\n${release.url}\n\nFollow normal Specification, testing and Ticket approvals before implementation. Merge approval remains manual.`;
    const idea: Implementation = { ...this.store.record(), title: `Update from ${release.repository} ${release.tag}`.slice(0, 200), description, project_id: project.id, provider: project.provider, machine_id: project.machine_id, stage: "inbox", position: this.store.list("implementations").length, outcome: "none", upstream_update: release };
    const chat: FactoryChat = { ...this.store.record(), implementation_id: idea.id, title: "Notes" };
    mkdirSync(join(this.store.root, "inbox", idea.id), { mode: 0o700 });
    this.store.put("implementations", idea);
    this.store.put("chats", chat, idea.id);
    this.store.put<FactoryMessage>("messages", { ...this.store.record(), implementation_id: idea.id, chat_id: chat.id, role: "system", content: description, source_id: null, sequence: null }, idea.id);
    this.store.event(idea.id, "upstream_release_detected", { release });
    return { implementation_id: idea.id, release };
  }
}
