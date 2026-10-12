/** A private test-only config artifact; never point this command at the owner's Herdr config. */
import { mkdirSync, writeFileSync, renameSync, lstatSync, readFileSync, chmodSync } from "node:fs";
import { resolve, join } from "node:path";

const CONFIG = "[update]\nversion_check = false\nmanifest_check = false\n";
export function writeTestHerdrConfig(directory: string): string {
  const dir = resolve(directory), path = join(dir, "config.toml");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink()) throw new Error("Test config directory must not be a symlink");
  if (process.platform !== "win32") chmodSync(dir, 0o700);
  let existing;
  try { existing = lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (existing) {
    if (!existing.isFile() || existing.isSymbolicLink() || readFileSync(path, "utf8") !== CONFIG) throw new Error("Refusing to replace existing Herdr configuration");
    if (process.platform !== "win32") chmodSync(path, 0o600);
    return path;
  }
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, CONFIG, { mode: 0o600 }); renameSync(temp, path);
  return path;
}
if (import.meta.main) {
  try {
    if (!process.argv[2] || process.argv.length !== 3) throw new Error("Usage: bun scripts/herdr-test-config.ts <owned-directory>");
    console.log(writeTestHerdrConfig(process.argv[2]));
  } catch (error) { console.error(error instanceof Error ? error.message : "Test config failed"); process.exitCode = 1; }
}
