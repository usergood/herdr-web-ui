import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";

// Exercise the complete installer with tool stand-ins and an isolated child profile.
// No real installs, GitHub account operations or running Herdr sessions are reachable.
const ROOT = join(import.meta.dir, "..");
const pcs: string[] = [];
afterAll(() => { for (const scratch of pcs) rmSync(scratch, { recursive: true, force: true }); });

class Pc {
  readonly scratch = mkdtempSync(join(tmpdir(), "saurons-eye-install-"));
  constructor() {
    pcs.push(this.scratch);
    const bin = join(this.scratch, "bin");
    mkdirSync(bin);
    mkdirSync(join(this.scratch, "plugin", "scripts"), { recursive: true });
    writeFileSync(join(this.scratch, "plugin", "scripts", "plugin.ts"), 'console.log("owned phone setup");\n');
    for (const name of ["sh", "cat", "uname", "ldd", "grep", "tar", "awk", "sed", "mktemp", "rm"]) {
      const tool = Bun.which(name);
      if (tool) symlinkSync(tool, join(bin, name));
    }
    symlinkSync(process.execPath, join(bin, "bun"));
    const tools: Record<string, string> = {
      herdr: `echo "$*" >> "$SCRATCH/herdr.calls"
case "$*" in
  --version) echo "herdr 0.9.3" ;;
  "plugin list") [ ! -e "$SCRATCH/installed" ] || echo "usergood.saurons-eye 0.4.3" ;;
  "plugin list --json") printf '{"result":{"plugins":[{"plugin_id":"usergood.saurons-eye","plugin_root":"%s"}]}}\\n' "$SCRATCH/plugin" ;;
  "plugin install "*) : > "$SCRATCH/installed"; echo "Installed usergood.saurons-eye" ;;
  "status server --json") echo '{"running":false}' ;;
  *) echo "unexpected herdr $*" >&2; exit 1 ;;
esac`,
      node: "echo v22.0.0",
      gh: 'echo "gh $*" >> "$SCRATCH/external.calls"; exit 1',
      curl: 'echo "curl $*" >> "$SCRATCH/external.calls"; exit 1',
      git: 'case "$*" in *"rev-parse HEAD") echo 0123456789012345678901234567890123456789 ;; *) echo "git $*" >> "$SCRATCH/external.calls"; exit 1 ;; esac',
    };
    for (const [name, body] of Object.entries(tools)) {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    }
  }
  calls(name: string): string[] {
    const log = join(this.scratch, name);
    return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
  }
  async install(ref: string): Promise<{ output: string; exitCode: number }> {
    const child = Bun.spawn(["sh"], {
      cwd: this.scratch,
      env: { PATH: join(this.scratch, "bin"), HOME: this.scratch, SCRATCH: this.scratch, SHELL: "/bin/sh", TERM: "xterm", HERDR_WEB_UI_REF: ref },
      stdin: Bun.file(join(ROOT, "install.sh")), stdout: "pipe", stderr: "pipe",
    });
    const [out, err, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { output: out + err, exitCode };
  }
}

describe.skipIf(platform() === "win32")("owner-configured installer", () => {
  it("requires a reviewed ref before querying accounts or installing anything", async () => {
    const pc = new Pc();
    const { output, exitCode } = await pc.install("");
    expect(exitCode).not.toBe(0);
    expect(output).toContain("set HERDR_WEB_UI_REF");
    expect(pc.calls("herdr.calls")).toEqual([]);
    expect(pc.calls("external.calls")).toEqual([]);
  });
  it("installs the owner's fork at the selected ref without account or upstream queries", async () => {
    const pc = new Pc();
    const { output, exitCode } = await pc.install("reviewed-commit");
    expect(exitCode).toBe(0);
    expect(output).toContain("Installed usergood.saurons-eye");
    expect(pc.calls("herdr.calls")).toContain("plugin install usergood/herdr-web-ui --ref reviewed-commit --yes");
    expect(pc.calls("external.calls")).toEqual([]);
    expect(output).not.toContain("star it now");
  });
  it("preserves an existing fork installation without querying accounts on rerun", async () => {
    const pc = new Pc();
    writeFileSync(join(pc.scratch, "installed"), "");
    expect((await pc.install("reviewed-commit")).exitCode).toBe(0);
    expect(pc.calls("herdr.calls").some((call) => call.startsWith("plugin install "))).toBe(false);
    expect(pc.calls("external.calls")).toEqual([]);
  });
});
