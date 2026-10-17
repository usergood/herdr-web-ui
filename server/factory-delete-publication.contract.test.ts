import { expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { publishedDeleteFixture } from "./factory-published-delete.fixture.ts";

it.each(["confirmed", "uncertain", "push-unknown"] as const)("Delete preserves a %s literal-URL publication through pending cleanup and restart", async mode => {
  const f = await publishedDeleteFixture();
  try {
    const published = await f.publish(mode);
    expect(published.status).toBe(200);
    expect(await published.json()).toMatchObject({ condition: mode === "confirmed" ? "confirmed" : "uncertain", head: f.head });
    expect(f.transportCalls()).toEqual([["-C", f.run.worktree!, "-c", "push.followTags=false", "push", "--", "https://github.com/fictional/project.git", `${f.head}:refs/heads/${f.run.branch}`]]);
    expect(f.git(["for-each-ref", "--format=%(refname)", "refs/remotes/"]).trim()).toBe("");
    expect(f.git(["config", "--list"]).split("\n").filter(line => line.startsWith("branch."))).toEqual([]);
    expect((await f.request(`/runs/${f.run.id}/stop`, {})).status).toBe(200);
    const local = await f.start("local-only-control");
    expect(local.worktree).toBeString();
    const independent = join(f.root, "independent-checkout");
    f.git(["worktree", "add", "-b", "independent-owned-control", independent, "main"]);
    writeFileSync(join(independent, "README.md"), "Unrelated checkout survives\n");
    writeFileSync(join(f.repo, "README.md"), "Unrelated primary changes survive\n");
    for (const run of [f.run, local]) writeFileSync(join(run.worktree!, "untracked-owned.txt"), "Owned dirty data to remove\n");
    f.git(["worktree", "lock", f.run.worktree!]);
    const pending = await f.request(f.prefix + "/delete", {}).then(r => r.json());
    expect(pending.condition).toBe("pending");
    expect(pending.reasons.join(" ")).toContain(`delivery-host / ${f.run.id}`);
    f.restart();
    expect((await f.request(f.prefix).then(r => r.json())).implementation.deletion.condition).toBe("pending");
    f.git(["worktree", "unlock", f.run.worktree!]);
    const deadline = Date.now() + 8000;
    let response = await f.request(f.prefix + "/delete", {});
    while (response.status !== 404 && (await f.request(f.prefix)).status !== 404) {
      if (Date.now() > deadline) throw new Error(`Owned Delete did not complete: ${await response.text()}`);
      await Bun.sleep(25);
      response = await f.request(f.prefix + "/delete", {});
    }
    expect((await f.request(f.prefix)).status).toBe(404);
    expect(f.git(["for-each-ref", "--format=%(objectname)", `refs/heads/${f.run.branch}`]).trim()).toBe(f.head);
    expect(f.git(["for-each-ref", "--format=%(objectname)", `refs/heads/${local.branch}`]).trim()).toBe("");
    expect(f.git(["--git-dir", f.bare, "rev-parse", `refs/heads/${f.run.branch}`]).trim()).toBe(f.head);
    const file = (path: string) => fetch(`http://localhost:${f.app.port}/api/fs/file?path=${encodeURIComponent(path)}`, { headers: { authorization: `Bearer ${f.token}` } });
    for (const run of [f.run, local]) expect((await file(join(run.worktree!, "untracked-owned.txt"))).status).toBe(404);
    expect(await file(join(f.repo, "README.md")).then(r => r.text())).toBe("Unrelated primary changes survive\n");
    expect(await file(join(independent, "README.md")).then(r => r.text())).toBe("Unrelated checkout survives\n");
    expect(f.uploads).toHaveLength(1);
  } finally { await f.close(); }
}, 60_000);
