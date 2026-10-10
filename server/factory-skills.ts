import { writePrivateFile } from "./factory-files.ts";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join } from "node:path";
import sourceLock from "../docs/factory/skills.lock.json";
import type { FactoryProvider } from "../shared/protocol.ts";
import { FactoryError, hash, withinRoot } from "./factory-host.ts";

export interface SkillManifest {
  commit: string; tag: string; hash: string; root: string;
  skills: { name: string; path: string }[];
  files: { path: string; mode: string; git_blob_sha: string; sha256: string }[];
}

/** Verify every locked support file and CLI metadata file, rather than just SKILL.md names. */
export function verifySkills(path: string | null): SkillManifest {
  if (!path || !isAbsolute(path)) throw new FactoryError("skills_missing", "Configure an absolute path to the pinned v1.3.1 skill source", 409);
  let root: string;
  try { root = realpathSync(path); } catch { throw new FactoryError("skills_missing", "The configured skill source is unavailable", 409); }
  const files: SkillManifest["files"] = [];
  for (const locked of sourceLock.files) {
    const file = join(root, locked.path);
    try {
      const info = lstatSync(file);
      const symlink = locked.mode === "120000";
      if (symlink ? !info.isSymbolicLink() || !withinRoot(root, realpathSync(file)) : !info.isFile() || realpathSync(file) !== file) throw new Error();
      const bytes = symlink ? Buffer.from(readlinkSync(file)) : readFileSync(file);
      if (bytes.length !== locked.size_bytes) throw new Error();
      const gitHash = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
      const mode = symlink ? "120000" : info.mode & 0o111 ? "100755" : "100644";
      if (gitHash !== locked.git_blob_sha || mode !== locked.mode) throw new Error();
      files.push({ path: locked.path, mode, git_blob_sha: gitHash, sha256: hash(bytes) });
    } catch { throw new FactoryError("skills_changed", `Missing or changed pinned skill file: ${locked.path}`, 409); }
  }
  const names = new Set(sourceLock.required_skills.map((skill) => skill.name));
  for (const skill of sourceLock.required_skills) {
    const document = readFileSync(join(root, skill.path, "SKILL.md"), "utf8");
    for (const call of document.matchAll(/Skill tool[^\n]*?["`]([a-z][a-z-]+)["`]/g)) {
      if (!names.has(call[1]!)) throw new FactoryError("skill_dependency_missing", `The pinned workflow requires ${call[1]}`, 409);
    }
  }
  return { commit: sourceLock.resolved_commit, tag: sourceLock.tag, root, files, skills: sourceLock.required_skills, hash: hash(JSON.stringify(files)) };
}

export function bundlePayload(manifest: SkillManifest): { files: { path: string; content_base64: string }[] } {
  return { files: manifest.files.map((file) => ({ path: file.path, content_base64: (file.mode === "120000" ? Buffer.from(readlinkSync(join(manifest.root, file.path))) : readFileSync(join(manifest.root, file.path))).toString("base64") })) };
}

/** Materialize only Git-object-verified bytes under private app state; never install globally. */
export function materializeSkills(root: string, body: Record<string, unknown>): string {
  const parent = join(root, "pinned-skills"); const destination = join(parent, sourceLock.resolved_commit);
  if (existsSync(destination)) { verifySkills(destination); return destination; }
  if (!Array.isArray(body.files) || body.files.length !== sourceLock.files.length) throw new FactoryError("invalid_bundle", "The complete pinned bundle is required");
  const content = new Map<string, Buffer>();
  for (const value of body.files) {
    if (!value || typeof value !== "object" || typeof value.path !== "string" || typeof value.content_base64 !== "string" || content.has(value.path)) throw new FactoryError("invalid_bundle", "Every pinned source file must appear exactly once");
    const locked = sourceLock.files.find((file) => file.path === value.path);
    if (!locked || value.content_base64.length > Math.ceil(locked.size_bytes / 3) * 4) throw new FactoryError("invalid_bundle", "Unexpected pinned source bytes");
    const bytes = Buffer.from(value.content_base64, "base64");
    if (bytes.length !== locked.size_bytes || createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== locked.git_blob_sha) throw new FactoryError("invalid_bundle", "A pinned source object failed verification");
    content.set(locked.path, bytes);
  }
  const staging = join(parent, randomUUID() + ".tmp");
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  for (const file of sourceLock.files) {
    const path = join(staging, file.path); mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const bytes = content.get(file.path)!;
    if (file.mode === "120000") symlinkSync(bytes.toString("utf8"), path);
    else { writeFileSync(path, bytes, { flag: "wx", mode: file.mode === "100755" ? 0o700 : 0o600 }); chmodSync(path, file.mode === "100755" ? 0o700 : 0o600); }
  }
  verifySkills(staging);
  renameSync(staging, destination); return destination;
}

/** Project-local native discovery; existing project skills are preserved on a conflict. */
export function provisionSkills(worktree: string, provider: FactoryProvider, manifest: SkillManifest): void {
  const directory = join(worktree, provider === "claude" ? ".claude" : provider === "opencode" ? ".opencode" : ".agents", "skills");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const skill of manifest.skills) {
    const target = join(directory, skill.name);
    if (existsSync(target)) throw new FactoryError("skill_conflict", `The checkout already defines ${skill.name}; reconcile it before starting`, 409);
    cpSync(join(manifest.root, skill.path), target, { recursive: true, dereference: false, errorOnExist: true, force: false });
  }
}

/** OpenCode ignores Claude's invocation metadata, so project-local permissions preserve the gate. */
export function provisionFactoryAgent(worktree: string, provider: FactoryProvider, selected: string, manifest: SkillManifest, readonly = false): void {
  if (provider !== "opencode") return;
  const folder = join(worktree, ".opencode", "agents"); mkdirSync(folder, { recursive: true, mode: 0o700 });
  const path = join(folder, "saurons-eye.md");
  if (existsSync(path)) throw new FactoryError("agent_policy_conflict", "The checkout already defines the factory agent; preserve and reconcile it", 409);
  const allowed = new Set<string>();
  const add = (name: string): void => {
    if (allowed.has(name)) return;
    const skill = manifest.skills.find((entry) => entry.name === name); if (!skill) return;
    allowed.add(name);
    const source = readFileSync(join(manifest.root, skill.path, "SKILL.md"), "utf8");
    for (const call of source.matchAll(/Skill tool[^\n]*?["`]([a-z][a-z-]+)["`]/g)) add(call[1]!);
  };
  if (selected === "verify-provider") for (const skill of manifest.skills) add(skill.name); else add(selected);
  const permissions = { task: "deny", ...(readonly ? { edit: "deny" } : {}), skill: { "*": "deny", ...Object.fromEntries([...allowed].map((name) => [name, "allow"])) } };
  writePrivateFile(path, `---\nname: saurons-eye\ndescription: Application-owned factory context\nmode: primary\npermission: ${JSON.stringify(permissions)}\n---\nUse only the explicitly selected action and its pinned dependencies. Never start unmanaged children. Read .saurons-eye-context.json and use the scoped tracker for questions, versioned answers, task worktrees and checks. Publication and acceptance belong to the owner.\n`, { flag: "wx", mode: 0o600 });
}
