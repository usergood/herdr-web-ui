import { randomUUID } from "node:crypto";
import { existsSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { FactoryError } from "./factory-host.ts";

/** Publish private immutable state atomically; preserve any unexpected destination. */
export function writePrivateFile(path: string, content: string | Uint8Array, _options?: { mode?: number; flag?: string }): void {
  if (existsSync(path)) throw new FactoryError("state_conflict", "Unexpected state exists at the proposed destination; preserve it", 409);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
    if (existsSync(path)) throw new FactoryError("state_conflict", "The state destination changed during publication", 409);
    renameSync(temporary, path);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
