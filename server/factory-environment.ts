import { mkdirSync } from "node:fs";
import { join } from "node:path";

/** One private environment policy for coordinators, workers and known check recipes. */
export function factoryEnvironment(root: string, runId: string, configured: Record<string, string> = {}, workerId?: string): Record<string, string> {
  for (const name of ["cache", "state", "notes", "tmp"]) mkdirSync(join(root, name), { recursive: true, mode: 0o700 });
  return { PORT: "0", ...configured, XDG_CACHE_HOME: join(root, "cache"), TMPDIR: join(root, "tmp"), FACTORY_DATABASE: join(root, "state", "tests.sqlite"), FACTORY_STATE_DIR: join(root, "state"), FACTORY_NOTES_DIR: join(root, "notes"), FACTORY_RUN_ID: runId, ...(workerId ? { FACTORY_WORKER_ID: workerId } : {}) };
}
