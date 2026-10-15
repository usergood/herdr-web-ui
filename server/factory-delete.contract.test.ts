import { describe, expect, it } from "bun:test";
import { capacityFixture } from "../scripts/factory-capacity-fixture.ts";
import { join } from "node:path";

describe("permanent Assignment Delete through authenticated HTTP", () => {
  it("reconciles a lost Machine cleanup acknowledgment across restart without relaunching deleted work", async () => {
    const f = await capacityFixture();
    try {
      const id = await f.assignment("Lost deletion acknowledgment");
      await f.api(`/implementations/${id}/runs`, { action: "work", idempotency_key: "owned" });
      f.loseNextDelete();
      expect((await f.api(`/implementations/${id}/delete`, {}).then(r => r.json())).condition).toBe("pending");
      expect((await f.api("").then(r => r.json())).capacity.normal.used).toBe(1);
      f.restart();
      expect(await f.api(`/implementations/${id}/delete`, {}).then(r => r.json())).toEqual({ id, condition: "deleted" });
      expect((await f.api(`/implementations/${id}`)).status).toBe(404);
      expect(f.launches).toHaveLength(1);
    } finally { f.close(); }
  });
  it("finishes deletion when older app-managed backups contain only unrelated Assignments", async () => {
    const f = await capacityFixture();
    try {
      const sibling = await f.assignment("Backed up sibling");
      await f.api("/backups", {});
      const id = await f.assignment("Never backed up");
      const response = await f.api(`/implementations/${id}/delete`, {});
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ id, condition: "deleted" });
      expect((await f.api(`/implementations/${sibling}`)).status).toBe(200);
      expect(await f.api("/backups").then(r => r.json())).toHaveLength(1);
    } finally { f.close(); }
  });
  it("does not recreate removed records when a child allocation reply arrives after Delete", async () => {
    const f = await capacityFixture(); const gate = f.holdNextAllocation(true);
    try {
      const id = await f.assignment("Late deleted child");
      const run = await f.api(`/implementations/${id}/runs`, { action: "work", idempotency_key: "root" }).then(r => r.json());
      const allocation = f.api(`/runs/${run.id}/workers`, { role: "standards", idempotency_key: "late-child" });
      await gate.started;
      expect((await f.api(`/implementations/${id}/delete`, {}).then(r => r.json())).condition).toBe("deleted");
      gate.release();
      expect((await allocation).status).toBe(409);
      f.restart();
      expect((await f.api(`/implementations/${id}`)).status).toBe(404);
      expect((await f.api("").then(r => r.json())).pane_links).toEqual([]);
    } finally { gate.release(); f.close(); }
  });
  it("fences owner and agent writes as soon as Delete is pending", async () => {
    const f = await capacityFixture();
    try {
      const id = await f.assignment("Deletion write fence");
      const run = await f.api(`/implementations/${id}/runs`, { action: "work", idempotency_key: "active" }).then(r => r.json());
      f.offline(true);
      await f.api(`/implementations/${id}/delete`, {});
      expect((await f.api(`/implementations/${id}/specifications`, { content: "A delayed new Specification" })).status).toBe(409);
      expect((await f.agent(run.id, "question", { question: "A delayed agent result" })).status).toBe(409);
      expect((await f.api(`/implementations/${id}/configure`, { description: "Do not recreate deleted content" })).status).toBe(409);
    } finally { f.close(); }
  });
  it("purges exclusive attachments and history while preserving independently referenced content", async () => {
    const f = await capacityFixture();
    try {
      const id = await f.assignment("Delete private retained material");
      const sibling = await f.assignment("Retain independent material");
      const detail = await f.api(`/implementations/${id}`).then(r => r.json());
      const other = await f.api(`/implementations/${sibling}`).then(r => r.json());
      const attach = (target: string, chatId: string, text: string) => f.api(`/implementations/${target}/artifacts`, { chat_id: chatId, name: "owned.txt", media_type: "text/plain", content_base64: Buffer.from(text).toString("base64") }).then(r => r.json());
      const exclusive = await attach(id, detail.chats[0].id, "Exclusive deleted material");
      const shared = await attach(id, detail.chats[0].id, "Independent shared material");
      const retained = await attach(sibling, other.chats[0].id, "Independent shared material");
      await f.api(`/implementations/${id}/specifications`, { content: "Delete this Specification history" });
      expect((await f.api(`/implementations/${id}/delete`, {}).then(r => r.json())).condition).toBe("deleted");
      expect((await f.api(`/artifacts/${exclusive.id}/source`)).status).toBe(404);
      const headers = { authorization: `Bearer ${f.token}` };
      const read = (hash: string) => fetch(`http://localhost:${f.app.port}/api/fs/file?path=${encodeURIComponent(join(f.state, "factory", "blobs", hash))}`, { headers });
      expect((await read(exclusive.hash)).status).toBe(404);
      expect(await f.api(`/artifacts/${retained.id}/source`).then(r => r.text())).toBe("Independent shared material");
      expect((await read(shared.hash)).status).toBe(200);
      expect((await f.api(`/implementations/${sibling}`).then(r => r.json())).artifacts).toHaveLength(1);
    } finally { f.close(); }
  });
  it("does not claim final deletion while app-managed backup cleanup remains unconfirmed", async () => {
    const f = await capacityFixture();
    try {
      const id = await f.assignment("Backup obligation");
      await f.api("/backups", {});
      const response = await f.api(`/implementations/${id}/delete`, {});
      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({ id, condition: "pending" });
      f.restart();
      const detail = await f.api(`/implementations/${id}`).then(r => r.json());
      expect(detail.implementation.deletion.reasons.join(" ")).toContain("backup");
      expect(detail.messages).toEqual([]);
      expect(detail.specifications).toEqual([]);
      expect(detail.implementation.description).toBe("");
    } finally { f.close(); }
  });
  it("keeps offline attempts pending across restart and automatically finishes after their Machine confirms deletion", async () => {
    const f = await capacityFixture();
    try {
      const id = await f.assignment("Offline deletion");
      const run = await f.api(`/implementations/${id}/runs`, { action: "work", idempotency_key: "first" }).then(r => r.json());
      await f.api(`/runs/${run.id}/stop`, {});
      const second = await f.api(`/implementations/${id}/runs`, { action: "work", idempotency_key: "second" }).then(r => r.json());
      await f.api(`/runs/${second.id}/workers`, { role: "standards", idempotency_key: "child" });
      f.offline(true);
      const response = await f.api(`/implementations/${id}/delete`, {});
      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({ id, condition: "pending" });
      f.restart();
      const detail = await f.api(`/implementations/${id}`).then(r => r.json());
      expect(detail.implementation.deletion.reasons.join(" ")).toContain("owned-a");
      expect((await f.api(`/implementations/${id}/resume`, {})).status).toBe(409);
      expect((await f.api(`/implementations/${id}/runs`, { action: "work", idempotency_key: "late" })).status).toBe(409);
      f.offline(false);
      const deadline = Date.now() + 8_000;
      let status = 200;
      while (Date.now() < deadline) { status = (await f.api(`/implementations/${id}`)).status; if (status === 404) break; await Bun.sleep(30); }
      expect(status).toBe(404);
      expect(f.runs.size).toBe(0);
      expect(f.workers.size).toBe(0);
      expect(f.launches).toHaveLength(2);
    } finally { f.close(); }
  }, 15_000);
  it("deletes unfinished work without spare agent capacity and makes repeated Delete safe", async () => {
    const f = await capacityFixture();
    try {
      await f.api("/settings", { max_agents: 1 });
      const holder = await f.assignment("Unrelated capacity holder");
      await f.api(`/implementations/${holder}/runs`, { action: "work", idempotency_key: "holder" });
      const id = await f.assignment("Unfinished work to remove");
      await f.api(`/implementations/${id}/runs`, { action: "work", idempotency_key: "queued" });
      const response = await f.api(`/implementations/${id}/delete`, {});
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ id, condition: "deleted" });
      expect((await f.api(`/implementations/${id}`)).status).toBe(404);
      expect((await f.api("").then(r => r.json())).implementations.map((i: any) => i.id)).toEqual([holder]);
      expect(await f.api(`/implementations/${id}/delete`, {}).then(r => r.json())).toEqual({ id, condition: "deleted" });
      expect(f.launches).toHaveLength(1);
      expect((await f.api(`/implementations/${holder}`).then(r => r.json())).runs[0].condition).toBe("working");
    } finally { f.close(); }
  });
});
