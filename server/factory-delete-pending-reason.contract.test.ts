import { it, expect } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { githubFixture } from "../scripts/factory-github-fixture.ts";

it("retains the confirmed Delete reason and local cleanup receipt while a slow GitHub retry is in flight", async () => {
  const f = await githubFixture();
  let retry: ReturnType<typeof f.post> | undefined;
  try {
    const route = `/projects/${f.project.id}/github`;
    expect((await f.post(route + "/configure", f.policy)).status).toBe(200);
    expect((await f.post(route + "/sync", {})).status).toBe(200);
    const id = (await f.get("")).implementations[0].id;
    const data = JSON.parse(readFileSync(f.state, "utf8"));
    data.permission = "WRITE"; writeFileSync(f.state, JSON.stringify(data));
    const first = await f.post(`/implementations/${id}/delete`, {});
    expect(first.body.condition).toBe("pending");
    expect(first.body.reasons.join(" ")).toContain("repository-admin");

    data.pause = true; writeFileSync(f.state, JSON.stringify(data));
    retry = f.post(`/implementations/${id}/delete`, {});
    const deadline = Date.now() + 4000;
    while (!existsSync(join(f.root, "reading"))) {
      if (Date.now() > deadline) throw new Error("Owned GitHub retry was not admitted");
      await Bun.sleep(10);
    }
    const current = await f.get(`/implementations/${id}`);
    expect(current.implementation.deletion.reasons.join(" ")).toContain("repository-admin");
    expect(current.implementation.deletion.local_cleanup).toBe("complete");
  } finally {
    writeFileSync(join(f.root, "continue"), "owned release");
    if (retry) await retry;
    f.close();
  }
}, 10000);
