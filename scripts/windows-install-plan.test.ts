import { expect, it } from "bun:test";
import { join } from "node:path";
const shell = process.env["SAURONS_POWERSHELL_BIN"] || Bun.which("powershell") || Bun.which("pwsh");

it.skipIf(!shell)("plans a reviewed commit without release history and an explicit forward update pair through the Windows CLI", async () => {
  const run = async (args: string[]) => {
    const child = Bun.spawn([shell!, "-NoProfile", "-NonInteractive", "-File", join(import.meta.dir, "windows-install-e2e.ps1"), "-Plan", ...args], { stdout: "pipe", stderr: "pipe" });
    const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { out, error, code };
  };
  const fresh = await run(["-Ref", "0123456789012345678901234567890123456789"]);
  expect(fresh.code).toBe(0); expect(JSON.parse(fresh.out)).toEqual({ mode: "fresh", install_ref: "0123456789012345678901234567890123456789", update_to: null, check_updates: false });
  const update = await run(["-Update", "-UpdateFrom", "v0.4.7", "-UpdateTo", "v0.4.8"]);
  expect(update.code).toBe(0); expect(JSON.parse(update.out)).toEqual({ mode: "update", install_ref: "v0.4.7", update_to: "v0.4.8", check_updates: true });
  expect((await run(["-Update", "-Ref", "main"])).code).not.toBe(0);
  expect((await run(["-Update", "-UpdateFrom", "v0.4.8", "-UpdateTo", "v0.4.7"])).code).not.toBe(0);
  expect((await run(["-Ref", "main", "-Installer", "https://example.test/install.ps1"])).code).not.toBe(0);
}, 20_000);
