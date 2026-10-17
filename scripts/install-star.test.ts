import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, watch, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";

// The fork never asks about upstream stars or inspects a signed-in GitHub account.
// Run its actual installer with an owned home and prerequisite/process stand-ins.
const ROOT = join(import.meta.dir, "..");
const STAND_INS: Record<string, string> = {
  herdr: `case "$*" in
  --version) echo "herdr 0.9.3" ;;
  "plugin list") [ ! -e "$SCRATCH/installed" ] || echo "usergood.saurons-eye 0.0.0" ;;
  "plugin list --json") printf '{"result":{"plugins":[{"plugin_id":"usergood.saurons-eye","plugin_root":"%s"}]}}\\n' "$SCRATCH/plugin" ;;
  "plugin install "*) : > "$SCRATCH/installed"; echo "Installed usergood.saurons-eye" ;;
  "status server --json") if [ -e "$SCRATCH/running" ]; then echo '{"running":true}'; else echo '{"running":false}'; fi ;;
  "plugin action invoke "*) ;;
  *) echo "unexpected herdr $*" >&2; exit 1 ;;
esac`,
  node: `echo v22.0.0`,
  // a desktop's openers, which only write down what they were asked to open (renamed into place: a reader never sees half a line)
  "xdg-open": `echo "$*" > "$SCRATCH/open.tmp" && mv "$SCRATCH/open.tmp" "$SCRATCH/open.calls"`,
  open: `echo "$*" > "$SCRATCH/open.tmp" && mv "$SCRATCH/open.tmp" "$SCRATCH/open.calls"`,
  gh: `echo "$*" >> "$SCRATCH/gh.calls"; exit 99`,
  curl: `echo "$*" >> "$SCRATCH/network.calls"; exit 99`,
  git: `case "$*" in *"rev-parse HEAD") printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\n' ;; *) echo "$*" >> "$SCRATCH/network.calls"; exit 99 ;; esac`,
};

class Pc {
  readonly scratch = mkdtempSync(join(tmpdir(), "herdr-install-star-"));

  constructor(gh = true) {
    pcs.push(this.scratch);
    const bin = join(this.scratch, "bin");
    mkdirSync(bin);
    mkdirSync(join(this.scratch, "plugin", "scripts"), { recursive: true });
    writeFileSync(join(this.scratch, "plugin", "scripts", "plugin.ts"), `import { existsSync } from "node:fs";\nif (process.argv[2] === "phone") console.log("the phone step");\nif (process.argv[2] === "status" && existsSync(process.env.SCRATCH + "/running")) console.log("running http://127.0.0.1:7317 (pid 1234)");\n`);
    for (const tool of ["sh", "bash", "cat", "uname", "ldd", "grep", "curl", "git", "tar", "awk", "sed", "mktemp", "rm", "sleep", "perl", "mv"]) {
      if (["curl", "git"].includes(tool)) continue;
      const real = Bun.which(tool);
      if (real) symlinkSync(real, join(bin, tool));
    }
    symlinkSync(process.execPath, join(bin, "bun"));
    for (const name of gh ? ["herdr", "node", "xdg-open", "open", "gh", "curl", "git"] : ["herdr", "node", "xdg-open", "open", "curl", "git"]) {
      writeFileSync(join(bin, name), `#!/bin/sh\n${STAND_INS[name]!}\n`);
      chmodSync(join(bin, name), 0o755);
    }

  }

  /** herdr is running, so the app starts and says where it is */
  running(): this { writeFileSync(join(this.scratch, "running"), ""); return this; }
  /**
   * What the browser opener was asked to open, or null when it never was.
   */
  async opened(wait: boolean): Promise<string | null> {
    const calls = join(this.scratch, "open.calls");
    const readCalls = (): string | null => {
      if (!existsSync(calls)) return null;
      const value = readFileSync(calls, "utf8").trim();
      return value || null;
    };
    const existing = readCalls();
    // The script backgrounds the opener only when it opens.
    if (existing !== null || !wait) return existing;

    let finish!: (value: string | null) => void;
    const result = new Promise<string | null>((resolve) => { finish = resolve; });
    const watcher = watch(this.scratch, (_event, filename) => {
      if (filename?.toString() !== "open.calls") return;
      const value = readCalls();
      if (value !== null) finish(value);
    });
    const timer = setTimeout(() => finish(null), 5_000);
    try {
      const afterWatch = readCalls();
      if (afterWatch !== null) finish(afterWatch);
      return await result;
    } finally {
      watcher.close();
      clearTimeout(timer);
    }
  }
  /** the plugin is there already: this run is a rerun */
  installed(): this { writeFileSync(join(this.scratch, "installed"), ""); return this; }
  ghCalls(): string[] {
    const log = join(this.scratch, "gh.calls");
    return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
  }
  networkCalls(): string[] {
    const log = join(this.scratch, "network.calls");
    return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
  }
  private environment(extra: Record<string, string> = {}): Record<string, string> {
    return { PATH: join(this.scratch, "bin"), HOME: this.scratch, XDG_CONFIG_HOME: join(this.scratch, "config"), HERDR_WEB_STATE_DIR: join(this.scratch, "state"), SCRATCH: this.scratch, SHELL: "/bin/sh", TERM: "xterm", HERDR_WEB_UI_REF: "v0.0.0", ...extra };
  }

  /** as a script or an agent runs it: the script on stdin, and no terminal */
  async unattended(extra?: Record<string, string>): Promise<{ out: string; exitCode: number }> {
    const child = Bun.spawn(["sh"], { cwd: this.scratch, env: this.environment(extra), stdin: Bun.file(join(ROOT, "install.sh")), stdout: "pipe", stderr: "pipe" });
    const [out, err, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { out: out + err, exitCode };
  }

}
const pcs: string[] = [];
afterAll(() => { for (const scratch of pcs) rmSync(scratch, { recursive: true, force: true }); });

it("keeps both installers free of upstream star requests and prompts", () => {
  for (const name of ["install.sh", "install.ps1"]) {
    const installer = readFileSync(join(ROOT, name), "utf8");
    expect(installer).not.toContain("user/starred/");
    expect(installer).not.toContain("star it now");
    expect(installer).not.toContain("a GitHub star helps");
    expect(installer).not.toContain("Invoke-GhApi");
  }
});

describe.skipIf(platform() === "win32")("fork installer account isolation", () => {
  for (const scenario of ["fresh", "rerun", "without gh", "running"] as const) {
    it(`installs ${scenario} without upstream account calls or a star prompt`, async () => {
      const pc = new Pc(scenario !== "without gh");
      if (scenario === "rerun") pc.installed();
      if (scenario === "running") pc.running();
      const { out, exitCode } = await pc.unattended({ CI: "1", HERDR_WEB_NO_OPEN: "1" });
      expect(exitCode).toBe(0);
      expect(out).toContain(scenario === "rerun" ? "already installed" : "Installed usergood.saurons-eye");
      expect(out).not.toContain("star it now");
      expect(out).not.toContain("a GitHub star helps");
      expect(pc.ghCalls()).toEqual([]);
      expect(pc.networkCalls()).toEqual([]);
    });
  }
  it("refuses an unspecified reviewed ref before installation or account discovery", async () => {
    const pc = new Pc();
    const { out, exitCode } = await pc.unattended({ HERDR_WEB_UI_REF: "" });
    expect(exitCode).not.toBe(0);
    expect(out).toContain("reviewed Saurons eye commit or tag");
    expect(existsSync(join(pc.scratch, "installed"))).toBe(false);
    expect(pc.ghCalls()).toEqual([]);
    expect(pc.networkCalls()).toEqual([]);
  });
});
