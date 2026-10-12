import { expect, it } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const shell = process.env["SAURONS_POWERSHELL_BIN"] || Bun.which("powershell") || Bun.which("pwsh");

it.skipIf(!shell)("downloads the known SHA-256 fixture and rejects different bytes through the public PowerShell CLI", async () => {
  const root = mkdtempSync(join(tmpdir(), "saurons-pinned-download-"));
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: request => new Response(new URL(request.url).pathname === "/valid" ? "abc" : "tampered") });
  try {
    const run = async (route: string, path: string) => {
      const child = Bun.spawn([shell!, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(import.meta.dir, "download-pinned.ps1"), "-Uri", `http://127.0.0.1:${server.port}/${route}`, "-Sha256", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "-OutFile", path], { stdout: "pipe", stderr: "pipe" });
      const error = await new Response(child.stderr).text(); return { code: await child.exited, error };
    };
    const good = join(root, "verified"), bad = join(root, "rejected");
    expect((await run("valid", good)).code).toBe(0); expect(readFileSync(good, "utf8")).toBe("abc");
    const result = await run("bad", bad); expect(result.code).not.toBe(0); expect(result.error).toContain("Checksum mismatch"); expect(existsSync(bad)).toBe(false);
  } finally { server.stop(true); rmSync(root, { recursive: true, force: true }); }
}, 20_000);
