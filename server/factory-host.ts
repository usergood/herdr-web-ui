import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import type { ProjectCheckout } from "../shared/protocol.ts";

export class FactoryError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) { super(message); }
}
export function hash(content: string | Uint8Array): string { return createHash("sha256").update(content).digest("hex"); }
export function withinRoot(root: string, path: string): boolean { const part = relative(root, path); return part !== "" && part !== ".." && !part.startsWith(".." + sep) && !isAbsolute(part); }
const execute = promisify(execFile);

/** Argument arrays and a bounded output budget; inherited Git routing cannot select another repo. */
export async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execute("git", ["-C", cwd, ...args], {
      timeout: 15_000, maxBuffer: 4 * 1024 * 1024, encoding: "utf8",
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))), GIT_TERMINAL_PROMPT: "0" },
    });
    return stdout;
  } catch { throw new FactoryError("git_failed", "The repository operation failed; verify the checkout and preserve unexpected work"); }
}

export async function inspectCheckout(path: string): Promise<Omit<ProjectCheckout, "id" | "created_at" | "updated_at" | "project_id" | "machine_id">> {
  if (!isAbsolute(path) || /[\0\r\n]/.test(path)) throw new FactoryError("invalid_checkout", "The checkout path must be absolute");
  let root: string;
  try { root = realpathSync(path); if (!statSync(root).isDirectory()) throw new Error(); }
  catch { throw new FactoryError("invalid_checkout", "The checkout directory is unavailable"); }
  const top = (await git(root, ["rev-parse", "--show-toplevel"])).trim();
  if (realpathSync(top) !== root) throw new FactoryError("wrong_checkout", "Select the Git repository root");
  const head = (await git(root, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
  const branch = (await git(root, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  const roots = (await git(root, ["rev-list", "--max-parents=0", "HEAD"])).trim().split("\n").sort();
  const instructions: ProjectCheckout["instructions"] = [];
  for (const name of ["AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md", "DESIGN.md", ".github/REVIEW.md", "docs/development.md"]) {
    const file = join(root, name);
    if (!existsSync(file)) continue;
    if (!withinRoot(root, realpathSync(file)) || statSync(file).size > 256 * 1024) throw new FactoryError("invalid_instructions", "Repository instructions must be bounded files inside this checkout");
    const content = readFileSync(file, "utf8");
    instructions.push({ path: name, hash: hash(content), content });
  }
  // Repository identity does not expose an origin URL which might embed credentials.
  return { path: root, repository: hash(JSON.stringify(roots)), head, branch, instructions };
}
