import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Exercise the whole lane without installing Chromium, building, or opening a browser.
const stub = `
bun() {
  case "$1" in
    -e) printf '/stub/chrome\\n';;
    scripts/demo-build.ts) printf 'DEMO_DIR=%s\\n' "$HERDR_DEMO_BUILD";;
    scripts/*) printf 'STEP=%s EVIDENCE=%s\\n' "$1" "\${UI_EVIDENCE_DIR:-}";;
  esac
  if [ "$1" = "\${FAIL_SCRIPT:-}" ]; then return 7; fi
}
sudo() { return 0; }
source "$1"
`;

async function lane(fail = "", kept = false, ci = "") {
  const dir = mkdtempSync(join(tmpdir(), "hwc-browser-test-"));
  try {
    const child = Bun.spawn(["bash", "-c", stub, "stub", join(import.meta.dir, "ci-browser.sh")], {
      cwd: dir,
      env: { ...process.env, BROWSER_PARALLEL: "", CI: ci, CHECK_DIR: kept ? dir : "", UI_EVIDENCE_DIR: "", FAIL_SCRIPT: fail, TMPDIR: dir },
      stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 5_000,
    });
    const [text, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(error).toBe("");
    const demo = text.match(/^DEMO_DIR=(.+)$/m)?.[1];
    expect(demo).toBeDefined();
    expect(existsSync(demo ?? "")).toBe(false);
    return { text, code, evidence: existsSync(join(dir, kept ? "" : ".ci", "browser-evidence")) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const rows = (text: string) => [...text.matchAll(/^(scripts\/\S+)\s+(\d+)\s+(\d+)$/gm)].map((row) => ({
  script: row[1], seconds: Number(row[2]), code: Number(row[3]),
}));

describe("browser lane", () => {
  it("summarizes passing and failing scripts and stops at the original exit code", async () => {
    const { text, code } = await lane("scripts/sticky-modifiers-regression.ts");
    expect(code).toBe(7);
    expect(rows(text)).toEqual([
      { script: "scripts/demo-build.ts", seconds: expect.any(Number), code: 0 },
      { script: "scripts/ui-regression.ts", seconds: expect.any(Number), code: 0 },
      { script: "scripts/factory-browser-regression.ts", seconds: expect.any(Number), code: 0 },
      { script: "scripts/workflow-conversations-browser-regression.ts", seconds: expect.any(Number), code: 0 },
      { script: "scripts/factory-capacity-browser-regression.ts", seconds: expect.any(Number), code: 0 },
      { script: "scripts/factory-parking-browser-regression.ts", seconds: expect.any(Number), code: 0 },
      { script: "scripts/factory-pause-browser-regression.ts", seconds: expect.any(Number), code: 0 },
      { script: "scripts/factory-board-browser-regression.ts", seconds: expect.any(Number), code: 0 },
      { script: "scripts/factory-delete-browser-regression.ts", seconds: expect.any(Number), code: 0 },
      { script: "scripts/factory-automatic-planning-browser-regression.ts", seconds: expect.any(Number), code: 0 },
      { script: "scripts/factory-automatic-execution-browser-regression.ts", seconds: expect.any(Number), code: 0 },
      { script: "scripts/factory-automatic-review-browser-regression.ts", seconds: expect.any(Number), code: 0 },
      { script: "scripts/factory-human-review-browser-regression.ts", seconds: expect.any(Number), code: 0 },
      { script: "scripts/factory-human-merge-browser-regression.ts", seconds: expect.any(Number), code: 0 },
      { script: "scripts/factory-human-feedback-browser-regression.ts", seconds: expect.any(Number), code: 0 },
