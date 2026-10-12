import { expect, it } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

it("keeps automatic source changes fast and treats documentation-only edits as documentation", async () => {
  const root = mkdtempSync(join(tmpdir(), "saurons-ci-automatic-"));
  try {
    const event = join(root, "event.json"), files = join(root, "files"), output = join(root, "output");
    writeFileSync(event, JSON.stringify({ pull_request: { draft: false } }));
    writeFileSync(files, "src/App.tsx\0README.md\0");
    const run = async () => {
      rmSync(output, { force: true });
      const child = Bun.spawn([process.execPath, join(import.meta.dir, "ci-policy.ts"), files], { env: { ...process.env, GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: event, GITHUB_OUTPUT: output, CI_FULL: "false" }, stdout: "ignore", stderr: "pipe" });
      expect(await child.exited).toBe(0); return readFileSync(output, "utf8");
    };
    expect(await run()).toBe("run_fast=true\nrun_full=false\ndraft=false\n");
    writeFileSync(files, "README.md\0docs/guide.md\0");
    expect(await run()).toBe("run_fast=false\nrun_full=false\ndraft=false\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("runs full publication validation even when the last commit only changes documentation", async () => {
  const root = mkdtempSync(join(tmpdir(), "saurons-ci-policy-"));
  try {
    const event = join(root, "event.json"), files = join(root, "files"), output = join(root, "output");
    writeFileSync(event, JSON.stringify({ inputs: { full: true } }));
    writeFileSync(files, "docs/factory/release.md\0");
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "ci-policy.ts"), files], {
      env: { ...process.env, GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_EVENT_PATH: event, GITHUB_OUTPUT: output, CI_FULL: "true" },
      stdout: "pipe", stderr: "pipe",
    });
    const error = await new Response(child.stderr).text();
    expect(await child.exited).toBe(0); expect(error).toBe("");
    expect(readFileSync(output, "utf8")).toBe("run_fast=true\nrun_full=true\ndraft=false\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
