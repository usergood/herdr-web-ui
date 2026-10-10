import { existsSync, lstatSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { FactoryProvider, FactoryRun, FactoryWorker } from "../shared/protocol.ts";
import type { FactoryNative } from "./factory-native.ts";
import { FactoryError, git, hash } from "./factory-host.ts";
import type { SkillManifest } from "./factory-skills.ts";
import { FactoryStore } from "./factory-store.ts";

/** Record only app-created files. Cleanup never force-removes unexpected or ignored work. */
export function recordScaffolding(store: FactoryStore, id: string, path: string, provider: FactoryProvider, manifest: SkillManifest): void {
  const folder = provider === "claude" ? ".claude" : provider === "opencode" ? ".opencode" : ".agents";
  const paths = [".saurons-eye-context.json", ".saurons-eye-access.json", ".saurons-eye-tracker.mjs", ...(provider === "opencode" ? [".opencode/agents/saurons-eye.md"] : [])];
  for (const skill of manifest.skills) for (const file of manifest.files) if (file.path.startsWith(skill.path + "/")) paths.push(`${folder}/skills/${skill.name}/${file.path.slice(skill.path.length + 1)}`);
  const files = paths.filter((name) => existsSync(join(path, name))).map((name) => ({ path: name, hash: hash(readFileSync(join(path, name))) }));
  store.put("host_scaffolding", { id, path, files });
}

export async function cleanupCheckouts(store: FactoryStore, native: FactoryNative, run: FactoryRun): Promise<{ removed: string[]; branches_retained: true; notes_retained: true }> {
  if (existsSync(join(store.root, "recovery-copy.json"))) throw new FactoryError("recovery_copy", "Cleanup is disabled on a restored copy", 409);
  if (!["completed", "cancelled", "failed"].includes(run.condition)) throw new FactoryError("run_owned", "Stop and observe the Run before cleanup", 409);
  if (store.list<{ run_id: string; condition: string }>("host_checks").some((check) => check.run_id === run.id && ["working", "interrupted"].includes(check.condition))) throw new FactoryError("build_owned", "An active or uncertain build still retains this worktree", 409);
  const workers = store.list<FactoryWorker>("host_workers", run.id);
  const snapshot = await native.snapshot();
  const candidates = [...workers.map((worker) => ({ id: worker.id, path: worker.worktree, branch: worker.branch })), { id: run.id, path: run.worktree, branch: run.branch }].filter((entry) => entry.path && entry.branch);
  const plans: { id: string; path: string; files: string[] }[] = [];
  for (const candidate of candidates) {
    const path = candidate.path!; if (!existsSync(path)) continue;
    if (realpathSync(path) !== path || snapshot.panes.some((pane) => pane.cwd && realpathSync(pane.cwd) === path) || (await git(path, ["branch", "--show-current"])).trim() !== candidate.branch) throw new FactoryError("cleanup_identity_changed", "Native ownership or the checkout identity changed; retain the worktree", 409);
    if ((await git(path, ["diff", "--name-only", "HEAD", "--"])).trim()) throw new FactoryError("dirty_worktree", "Uncommitted changes must remain in their worktree", 409);
    const recorded = store.get<{ files: { path: string; hash: string }[] }>("host_scaffolding", candidate.id);
    if (!recorded) throw new FactoryError("scaffolding_unverified", "The app's generated files cannot be verified; retain this checkout", 409);
    const other = [...(await git(path, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0"), ...(await git(path, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"])).split("\0")].filter(Boolean);
    if (other.some((name) => !recorded.files.some((file) => file.path === name))) throw new FactoryError("outputs_unretained", "Unexpected or ignored outputs must remain in their worktree", 409);
    for (const file of recorded.files) {
      const full = join(path, file.path);
      if (!existsSync(full)) continue;
      if (lstatSync(full).isSymbolicLink() || realpathSync(full) !== full || hash(readFileSync(full)) !== file.hash) throw new FactoryError("scaffolding_changed", "A generated file changed; preserve it for review", 409);
    }
    plans.push({ id: candidate.id, path, files: recorded.files.map((file) => join(path, file.path)) });
  }
  const removed: string[] = [];
  for (const plan of plans) {
    for (const file of plan.files) if (existsSync(file)) unlinkSync(file);
    await git(run.checkout!, ["worktree", "remove", plan.path]); // No force; every branch and sibling notes directory survives.
    removed.push(plan.path); store.put("cleaned_checkouts", { id: plan.id, path: plan.path, cleaned_at: new Date().toISOString() }, run.id);
  }
  return { removed, branches_retained: true, notes_retained: true };
}
