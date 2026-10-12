import { expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

it("refuses to replace an existing configuration through the CLI", async () => {
  const root = mkdtempSync(join(tmpdir(), "saurons-config-preserved-"));
  try {
    const path = join(root, "config.toml"); writeFileSync(path, "# owned existing settings\n");
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "herdr-test-config.ts"), root], { stdout: "ignore", stderr: "pipe" });
    expect(await child.exited).not.toBe(0); expect(readFileSync(path, "utf8")).toBe("# owned existing settings\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("produces a private Herdr configuration with network refreshes disabled through the CLI", async () => {
  const root = mkdtempSync(join(tmpdir(), "saurons-herdr-config-"));
  try {
    const dir = join(root, "owned");
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "herdr-test-config.ts"), dir], { stdout: "pipe", stderr: "pipe" });
    const path = (await new Response(child.stdout).text()).trim();
    expect(await child.exited).toBe(0);
    const config = Bun.TOML.parse(readFileSync(path, "utf8"));
    expect(config.update).toEqual({ version_check: false, manifest_check: false });
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o777).toBe(0o600); expect(statSync(dir).mode & 0o777).toBe(0o700);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
