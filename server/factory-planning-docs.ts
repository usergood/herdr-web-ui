import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { FactoryRun } from "../shared/protocol.ts";
import { FactoryError, git, hash, withinRoot } from "./factory-host.ts";
import { writePrivateFile } from "./factory-files.ts";

/** Freeze changed planning documents in the owned output area before closing the native workspace. */
export async function stagePlanningDocuments(run: FactoryRun, assertPublic: (text: string) => void): Promise<Set<string> | null> {
  if (!["setup", "grill-me", "grill-with-docs", "to-spec", "to-tickets"].includes(run.action) || !run.worktree || !run.base || !run.branch) return null;
  const root = run.worktree; const notes = join(dirname(root), "notes");
  if (realpathSync(root) !== root || realpathSync(notes) !== notes || realpathSync((await git(root, ["rev-parse", "--show-toplevel"])).trim()) !== root || (await git(root, ["branch", "--show-current"])).trim() !== run.branch) throw new FactoryError("planning_identity_changed", "Planning documents must come from this Run's owned checkout", 409);
  const paths = new Set([
    ...(await git(root, ["diff", "--name-only", "-z", run.base, "--"])).split("\0"),
    ...(await git(root, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0"),
  ].filter(path => /\.md$/i.test(path) && !/^(?:\.agents|\.claude|\.opencode|\.saurons-eye)(?:\/|-|$)/.test(path)));
  if (paths.size > 50) throw new FactoryError("planning_documents_too_large", "Keep a planning handoff within 50 Markdown documents", 413);
  const index: { path: string; file: string; hash: string }[] = []; let total = 0;
  const publish = (name: string, bytes: Uint8Array): void => {
    const file = join(notes, name);
    if (existsSync(file)) {
      const info = lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || hash(readFileSync(file)) !== hash(bytes)) throw new FactoryError("planning_output_changed", "Preserve unexpected changes in the retained planning outputs", 409);
    } else writePrivateFile(file, bytes);
  };
  for (const path of [...paths].sort()) {
    const file = resolve(root, path); if (!withinRoot(root, file)) throw new FactoryError("planning_document_escape", "Keep planning documents inside the owned checkout", 403);
    if (!existsSync(file)) continue; // Deleted documents have no content to hand off.
    let descriptor: number | undefined;
    try {
      if (realpathSync(file) !== file || lstatSync(file).isSymbolicLink()) throw new FactoryError("planning_document_escape", "Planning documents cannot use symbolic links", 403);
      descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const info = fstatSync(descriptor);
      if (!info.isFile() || info.nlink !== 1 || info.size > 512 * 1024 || total + info.size > 2 * 1024 * 1024) throw new FactoryError("planning_documents_too_large", "Planning documents must be regular files within the 2 MiB handoff budget", 413);
      const bytes = readFileSync(descriptor);
      if (bytes.length !== info.size || realpathSync(file) !== file || lstatSync(file).ino !== info.ino) throw new FactoryError("planning_document_changed", "A planning document changed during capture; try finishing the step again", 409);
      assertPublic(bytes.toString("utf8")); total += bytes.length;
      const digest = hash(bytes); const name = `planning-${hash(path).slice(0, 16)}-${digest.slice(0, 16)}-${basename(path).slice(-100)}`;
      publish(name, bytes); index.push({ path, file: name, hash: digest });
    } finally { if (descriptor !== undefined) closeSync(descriptor); }
  }
  const current = new Set(index.map(document => document.file));
  if (index.length) {
    const content = JSON.stringify({ run_id: run.id, base: run.base, documents: index }, null, 2);
    const name = `planning-index-${hash(content).slice(0, 24)}.json`;
    publish(name, Buffer.from(content)); current.add(name);
  }
  return current;
}
