import { existsSync, lstatSync, realpathSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import type { FactoryDeleteAttemptResult, FactoryRun, FactoryWorker } from "../shared/factory.ts";
import { FactoryError, git, inspectCheckout, withinRoot } from "./factory-host.ts";
import type { FactoryNative } from "./factory-native.ts";
import type { FactoryStore } from "./factory-store.ts";

interface Candidate { id: string; path: string; branch: string | null; head: string | null; preserve_branch: boolean; removed: boolean; branch_done: boolean }
interface Intent { id: string; implementation_id: string; deletion_id: string; root: string; root_identity: string | null; checkout: string | null; repository: string | null; candidates: Candidate[]; condition: "pending" | "deleted" }

/** This destructive path is intentionally separate from conservative clean-checkout cleanup. */
export async function deleteHostFiles(store: FactoryStore, native: FactoryNative, run: FactoryRun, deletionId: string): Promise<FactoryDeleteAttemptResult> {
  let intent = store.get<Intent>("host_deletions", run.id);
  if (intent && (intent.deletion_id !== deletionId || intent.implementation_id !== run.implementation_id)) throw new FactoryError("delete_conflict", "Another deletion owns this native attempt", 409);
  const root = run.checkout ? join(store.root, "worktrees", run.id) : join(store.root, "inbox", run.implementation_id, run.id);
  const assertDirectory = (path: string) => {
    const info = lstatSync(path, { throwIfNoEntry: false });
    if (info && (!info.isDirectory() || info.isSymbolicLink() || realpathSync(path) !== path)) throw new FactoryError("delete_identity_changed", "An owned cleanup directory changed identity", 409);
  };
  const rootIdentity = () => { const info = lstatSync(root, { throwIfNoEntry: false }); return info ? `${info.dev}:${info.ino}` : null; };
  assertDirectory(root);
  if (intent?.root_identity && rootIdentity() && intent.root_identity !== rootIdentity()) throw new FactoryError("delete_identity_changed", "The cleanup root was replaced; preserve it", 409);
  const repository = run.checkout ? (run.manifest as { checkout?: { repository?: string } }).checkout?.repository : null;
  if (run.checkout && (!repository || (await inspectCheckout(run.checkout)).repository !== repository)) throw new FactoryError("delete_identity_changed", "The primary repository identity changed; preserve its work", 409);
  const snapshot = await native.snapshot();
  if (snapshot.panes.some(p => !p.cwd && !p.foreground_cwd || [p.cwd, p.foreground_cwd].some(cwd => cwd && (cwd === root || withinRoot(root, cwd))))) throw new FactoryError("delete_execution_uncertain", "A native pane may still use owned deletion data", 409);
  const children = store.list<FactoryWorker>("host_workers", run.id);
  // Literal-URL publication leaves no Git tracking ref. Prepared receipts count too:
  // the push can have succeeded before an interrupted reply or PR creation.
  const publishedBranch = (branch: string) => store.list<{ run_id: string; branch: string }>("host_publications", run.id).some(publication => publication.run_id === run.id && publication.branch === branch);
  if (!intent) {
    const candidates: Candidate[] = [];
    for (const target of [...children, run]) {
      const isRoot = target.id === run.id;
      const path = isRoot ? join(root, run.checkout ? "integration" : "workspace") : join(root, "workers", target.id, "checkout");
      const branch = run.checkout ? isRoot ? `saurons-eye/${run.implementation_id}/${run.id}` : `${run.branch}-${(target as FactoryWorker).role}-${target.id}` : null;
      if (target.worktree && target.worktree !== path || target.branch && target.branch !== branch) throw new FactoryError("delete_identity_changed", "Recorded worktree or branch is outside this attempt's ownership", 409);
      if (!target.worktree && existsSync(path)) throw new FactoryError("delete_identity_changed", "An unrecorded checkout exists at the cleanup path; preserve it", 409);
      assertDirectory(path);
      let head: string | null = null; let preserveBranch = branch !== null && publishedBranch(branch);
      if (run.checkout && branch) {
        const refs = (await git(run.checkout, ["for-each-ref", "--format=%(refname) %(objectname)", `refs/heads/${branch}`, "refs/remotes/"])).trim().split("\n");
        head = refs.find(ref => ref.startsWith(`refs/heads/${branch} `))?.split(" ")[1] ?? null;
        if (head && !target.branch) throw new FactoryError("delete_identity_changed", "An unrecorded branch exists at the cleanup identity; preserve it", 409);
        preserveBranch ||= refs.some(ref => ref.split(" ")[0]!.endsWith(`/${branch}`) && ref.startsWith("refs/remotes/"));
        if ((await git(run.checkout, ["config", "--get-regexp", `^branch\\.${branch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.`]).catch(() => "")).trim()) preserveBranch = true;
      }
      candidates.push({ id: target.id, path, branch, head, preserve_branch: preserveBranch, removed: false, branch_done: false });
    }
    intent = { id: run.id, implementation_id: run.implementation_id, deletion_id: deletionId, root, root_identity: rootIdentity(), checkout: run.checkout, repository: repository ?? null, candidates, condition: "pending" };
    store.put("host_deletions", intent);
  }
  if (intent.condition === "deleted") return { run_id: run.id, deletion_id: deletionId, condition: "deleted" };
  if (intent.root !== root || intent.checkout !== run.checkout) throw new FactoryError("delete_identity_changed", "The retained deletion plan changed", 409);
  for (const lease of store.list<{ run: FactoryRun }>("host_leases")) if (lease.run.id !== run.id && lease.run.worktree && (lease.run.worktree === root || withinRoot(root, lease.run.worktree))) throw new FactoryError("delete_shared_resource", "Another attempt references this cleanup directory", 409);
  const worktrees = run.checkout ? (await git(run.checkout, ["worktree", "list", "--porcelain"])).split("\n\n").map(entry => {
    const path = /^worktree (.*)$/m.exec(entry)?.[1];
    return { path: path ? resolve(path) : undefined, branch: /^branch refs\/heads\/(.*)$/m.exec(entry)?.[1], locked: /^locked/m.test(entry) };
  }) : [];
  if (worktrees.some(w => w.path && withinRoot(root, w.path) && !intent!.candidates.some(c => c.path === w.path))) throw new FactoryError("delete_shared_resource", "An unowned checkout exists inside this attempt; preserve it", 409);
  // Verify the complete plan before the first destructive effect.
  for (const candidate of intent.candidates) {
    assertDirectory(candidate.path);
    if (candidate.removed && existsSync(candidate.path)) throw new FactoryError("delete_identity_changed", "A removed checkout path was reused; preserve the replacement", 409);
    if (candidate.branch && (publishedBranch(candidate.branch) || worktrees.some(w => w.branch === candidate.branch && w.path !== candidate.path))) candidate.preserve_branch = true;
    if (existsSync(candidate.path) && run.checkout) {
      const listed = worktrees.find(w => w.path === candidate.path);
      if (!listed || listed.locked || listed.branch !== candidate.branch || (await git(candidate.path, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim() !== (await git(run.checkout, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim()) throw new FactoryError("delete_identity_changed", "Worktree registration, lock or repository changed; preserve it", 409);
    }
  }
  store.put("host_deletions", intent);
  for (const candidate of intent.candidates) {
    if (!candidate.removed) {
      if (existsSync(candidate.path)) {
        if (run.checkout) await git(run.checkout, ["worktree", "remove", "--force", candidate.path]);
        else rmSync(candidate.path, { recursive: true });
      } else if (worktrees.some(w => w.path === candidate.path)) {
        // A crash after Git removed the directory can leave an administrative entry.
        await git(run.checkout!, ["worktree", "remove", "--force", candidate.path]);
      }
      candidate.removed = true; store.put("host_deletions", intent);
    }
    if (!candidate.branch_done && candidate.branch && run.checkout) {
      // Refresh monotonically for retained plans, including plans frozen by older bridges.
      if (publishedBranch(candidate.branch)) candidate.preserve_branch = true;
      const current = (await git(run.checkout, ["for-each-ref", "--format=%(objectname)", `refs/heads/${candidate.branch}`])).trim();
      if (!candidate.preserve_branch && current) {
        if (current !== candidate.head || (await git(run.checkout, ["worktree", "list", "--porcelain"])).includes(`branch refs/heads/${candidate.branch}\n`)) throw new FactoryError("delete_branch_changed", "The local branch changed or is independently checked out; preserve it", 409);
        await git(run.checkout, ["update-ref", "-d", `refs/heads/${candidate.branch}`, current]);
      }
      candidate.branch_done = true; store.put("host_deletions", intent);
    }
  }
  assertDirectory(root);
  if (intent.root_identity && rootIdentity() && intent.root_identity !== rootIdentity()) throw new FactoryError("delete_identity_changed", "The cleanup root was replaced; preserve it", 409);
  if (existsSync(root)) rmSync(root, { recursive: true });
  store.put("host_deletions", { ...intent, condition: "deleted" });
  return { run_id: run.id, deletion_id: deletionId, condition: "deleted" };
}
