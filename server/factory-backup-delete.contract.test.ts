import { describe, expect, it } from "bun:test";
import { capacityFixture } from "../scripts/factory-capacity-fixture.ts";
import { createServer } from "./index.ts";
import { join } from "node:path";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";

describe("Assignment deletion from app-managed recovery through authenticated HTTP", () => {
  it("purges an Assignment from retained snapshots while another Assignment remains recoverable", async () => {
    const f = await capacityFixture();
    let copy: ReturnType<typeof createServer> | undefined;
    try {
      const deleted = await f.assignment("Private backed up Assignment");
      const retained = await f.assignment("Recoverable sibling");
      const attach = async (id: string, text: string) => {
        const detail = await f.api(`/implementations/${id}`).then(r => r.json());
        return f.api(`/implementations/${id}/artifacts`, { chat_id: detail.chats[0].id, name: "evidence.txt", media_type: "text/plain", content_base64: Buffer.from(text).toString("base64") }).then(r => r.json());
      };
      const exclusive = await attach(deleted, "Private exclusive evidence");
      await attach(deleted, "Shared retained evidence");
      const shared = await attach(retained, "Shared retained evidence");
      await f.api(`/implementations/${deleted}/specifications`, { content: "Private Specification history" });
      const backup = await f.api("/backups", {}).then(r => r.json());

      expect(await f.api(`/implementations/${deleted}/delete`, {}).then(r => r.json())).toEqual({ id: deleted, condition: "deleted" });
      const response = await f.api(`/backups/${backup.id}/restore`, {});
      expect(response.status).toBe(201);
      const restored = await response.json();
      copy = createServer({ port: 0, stateDir: restored.state_dir, token: f.token, machines: false, factory: { accountDiscoveryHome: f.state } });
      const read = (path: string) => fetch(`http://localhost:${copy!.port}/api/factory${path}`, { headers: { authorization: `Bearer ${f.token}` } });
      expect((await read(`/implementations/${deleted}`)).status).toBe(404);
      expect((await read(`/artifacts/${exclusive.id}/source`)).status).toBe(404);
      expect((await read(`/implementations/${retained}`).then(r => r.json())).implementation.title).toBe("Recoverable sibling");
      expect(await read(`/artifacts/${shared.id}/source`).then(r => r.text())).toBe("Shared retained evidence");
      expect((await f.api("/backups").then(r => r.json()))[0].blobs).toEqual([{ hash: shared.hash, size: shared.size }]);
    } finally { copy?.stop(); f.close(); }
  });
  it("purges existing recovery copies and their snapshots while preserving shared blobs across concurrent backup requests", async () => {
    const f = await capacityFixture();
    const copies: ReturnType<typeof createServer>[] = [];
    try {
      const deleted = await f.assignment("Erased recovery content");
      const sibling = await f.assignment("Preserved recovery content");
      const attach = async (id: string, text: string) => {
        const detail = await f.api(`/implementations/${id}`).then(r => r.json());
        return f.api(`/implementations/${id}/artifacts`, { chat_id: detail.chats[0].id, name: "evidence.txt", media_type: "text/plain", content_base64: Buffer.from(text).toString("base64") }).then(r => r.json());
      };
      const exclusive = await attach(deleted, "Private copy bytes that must disappear");
      await attach(deleted, "Shared copy bytes");
      const shared = await attach(sibling, "Shared copy bytes");
      const first = await f.api("/backups", {}).then(r => r.json());
      const recovery = await f.api(`/backups/${first.id}/restore`, {}).then(r => r.json());
      const copy = createServer({ port: 0, stateDir: recovery.state_dir, token: f.token, machines: false, factory: { accountDiscoveryHome: f.state } }); copies.push(copy);
      const request = (app: typeof copy, path: string, body?: unknown) => fetch(`http://localhost:${app.port}/api/factory${path}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json", "x-herdr-factory": "1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const nested = await request(copy, "/backups", {}).then(r => r.json());
      const results = await Promise.all([f.api("/backups", {}), f.api(`/implementations/${deleted}/delete`, {}), request(copy, "/backups", {})]);
      expect(results.map(r => r.status)).toEqual([201, 200, 201]);
      expect((await request(copy, `/implementations/${deleted}`)).status).toBe(404);
      expect(await request(copy, `/artifacts/${shared.id}/source`).then(r => r.text())).toBe("Shared copy bytes");
      const snapshots = await f.api("/backups").then(r => r.json());
      for (const snapshot of snapshots) {
        const restored = await f.api(`/backups/${snapshot.id}/restore`, {}).then(r => r.json());
        const app = createServer({ port: 0, stateDir: restored.state_dir, token: f.token, machines: false, factory: { accountDiscoveryHome: f.state } }); copies.push(app);
        expect((await request(app, `/implementations/${deleted}`)).status).toBe(404);
        expect(await request(app, `/artifacts/${shared.id}/source`).then(r => r.text())).toBe("Shared copy bytes");
        expect(snapshot.blobs).toEqual([{ hash: shared.hash, size: shared.size }]);
      }
      const restoredNested = await request(copy, `/backups/${nested.id}/restore`, {});
      expect(restoredNested.status).toBe(201);
      const nestedState = await restoredNested.json();
      const nestedApp = createServer({ port: 0, stateDir: nestedState.state_dir, token: f.token, machines: false, factory: { accountDiscoveryHome: f.state } }); copies.push(nestedApp);
      expect((await request(nestedApp, `/implementations/${deleted}`)).status).toBe(404);
      for (const directory of [join(f.state, "factory"), ...snapshots.map((s: { id: string }) => join(f.state, "factory", "backups", s.id)), join(recovery.state_dir, "factory"), join(recovery.state_dir, "factory", "backups", nested.id)]) {
        const file = (path: string) => fetch(`http://localhost:${f.app.port}/api/fs/file?path=${encodeURIComponent(path)}`, { headers: { authorization: `Bearer ${f.token}` } });
        expect((await file(join(directory, "blobs", exclusive.hash))).status).toBe(404);
        expect((await file(join(directory, "blobs", shared.hash))).status).toBe(200);
      }
    } finally { for (const app of copies.reverse()) app.stop(); f.close(); }
  });
  it("recovers an interrupted snapshot rewrite after restart and fences backup/restore until cleanup succeeds", async () => {
    const f = await capacityFixture();
    let copy: ReturnType<typeof createServer> | undefined;
    try {
      const deleted = await f.assignment("Interrupted private history");
      const sibling = await f.assignment("Recoverable after interruption");
      const backup = await f.api("/backups", {}).then(r => r.json());
      // Filesystem boundary fault: database publication succeeds but manifest publication fails.
      const obstacle = join(f.state, "factory", "backups", backup.id, "manifest.json.tmp");
      mkdirSync(obstacle);
      const result = await f.api(`/implementations/${deleted}/delete`, {}).then(r => r.json());
      expect(result.condition).toBe("pending");
      expect(result.reasons.join(" ")).toContain("backup");
      f.restart();
      expect((await f.api("/backups", {})).status).toBe(409);
      expect((await f.api(`/backups/${backup.id}/restore`, {})).status).toBe(409);
      rmSync(obstacle, { recursive: true });
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline && (await f.api(`/implementations/${deleted}`)).status !== 404) await Bun.sleep(30);
      expect((await f.api(`/implementations/${deleted}`)).status).toBe(404);
      expect(await f.api(`/implementations/${deleted}/delete`, {}).then(r => r.json())).toEqual({ id: deleted, condition: "deleted" });
      const response = await f.api(`/backups/${backup.id}/restore`, {});
      expect(response.status).toBe(201);
      const recovery = await response.json();
      copy = createServer({ port: 0, token: f.token, stateDir: recovery.state_dir, machines: false, factory: { accountDiscoveryHome: f.state } });
      const read = (id: string) => fetch(`http://localhost:${copy!.port}/api/factory/implementations/${id}`, { headers: { authorization: `Bearer ${f.token}` } });
      expect((await read(deleted)).status).toBe(404);
      expect((await read(sibling)).status).toBe(200);
    } finally { copy?.stop(); f.close(); }
  }, 15_000);
  it("cleans abandoned in-flight backup and restore staging directories without losing retained snapshots", async () => {
    const f = await capacityFixture();
    let copy: ReturnType<typeof createServer> | undefined;
    try {
      const deleted = await f.assignment("Interrupted staging history");
      const sibling = await f.assignment("Retained published recovery");
      const snapshot = await f.api("/backups", {}).then(r => r.json());
      const recovery = await f.api(`/backups/${snapshot.id}/restore`, {}).then(r => r.json());
      const root = join(f.state, "factory", "backups");
      const staging = join(root, randomUUID() + ".tmp");
      cpSync(join(root, snapshot.id), staging, { recursive: true });
      rmSync(join(staging, "manifest.json")); // Snapshot interrupted before manifest publication.
      const restoreStaging = join(root, "restore-" + randomUUID() + ".tmp");
      cpSync(recovery.state_dir, restoreStaging, { recursive: true });
      rmSync(join(restoreStaging, "factory", "recovery-copy.json")); // Restore interrupted before its inert marker.
      f.restart();
      expect(await f.api(`/implementations/${deleted}/delete`, {}).then(r => r.json())).toEqual({ id: deleted, condition: "deleted" });
      const file = (path: string) => fetch(`http://localhost:${f.app.port}/api/fs/file?path=${encodeURIComponent(path)}`, { headers: { authorization: `Bearer ${f.token}` } });
      expect((await file(join(staging, "records.sqlite"))).status).toBe(404);
      expect((await file(join(restoreStaging, "factory", "records.sqlite"))).status).toBe(404);
      const result = await f.api(`/backups/${snapshot.id}/restore`, {});
      expect(result.status).toBe(201);
      const restored = await result.json();
      copy = createServer({ port: 0, token: f.token, stateDir: restored.state_dir, machines: false, factory: { accountDiscoveryHome: f.state } });
      const read = (id: string) => fetch(`http://localhost:${copy!.port}/api/factory/implementations/${id}`, { headers: { authorization: `Bearer ${f.token}` } });
      expect((await read(deleted)).status).toBe(404);
      expect((await read(sibling)).status).toBe(200);
    } finally { copy?.stop(); f.close(); }
  });
  it("removes copied evidence and references from shared Project retrospectives without discarding sibling evidence", async () => {
    const f = await capacityFixture();
    let copy: ReturnType<typeof createServer> | undefined;
    try {
      const deleted = await f.assignment("Deleted Project evidence");
      const sibling = await f.assignment("Shared Project evidence");
      const detail = await f.api(`/implementations/${deleted}`).then(r => r.json());
      await f.api(`/implementations/${sibling}/configure`, { project_id: detail.implementation.project_id });
      const attach = async (id: string, note: string) => {
        const view = await f.api(`/implementations/${id}`).then(r => r.json());
        return f.api(`/implementations/${id}/artifacts`, { chat_id: view.chats[0].id, name: "retrospective.txt", note, media_type: "text/plain", content_base64: Buffer.from(note).toString("base64") }).then(r => r.json());
      };
      const exclusive = await attach(deleted, "Exclusive private retrospective annotation");
      const retained = await attach(sibling, "Retain sibling retrospective annotation");
      const retro = await f.api(`/projects/${detail.implementation.project_id}/retrospectives`, { evidence_ids: [exclusive.id, retained.id], proposal: "Retain shared Project lessons" }).then(r => r.json());
      expect((await f.api(`/retrospectives/${retro.id}/approve`, { scope_hash: retro.scope_hash })).status).toBe(200);
      const snapshot = await f.api("/backups", {}).then(r => r.json());
      expect((await f.api(`/implementations/${deleted}/delete`, {}).then(r => r.json())).condition).toBe("deleted");
      const restored = await f.api(`/backups/${snapshot.id}/restore`, {}).then(r => r.json());
      copy = createServer({ port: 0, token: f.token, stateDir: restored.state_dir, machines: false, factory: { accountDiscoveryHome: f.state } });
      const view = await fetch(`http://localhost:${copy.port}/api/factory/implementations/${sibling}`, { headers: { authorization: `Bearer ${f.token}` } }).then(r => r.json());
      const recoveredRetro = view.retrospectives.find((entry: { id: string }) => entry.id === retro.id);
      expect(recoveredRetro.evidence_ids).toEqual([retained.id]);
      expect(recoveredRetro.approved).toBe(false);
      expect(recoveredRetro.scope_hash).not.toBe(retro.scope_hash);
      const response = await fetch(`http://localhost:${f.app.port}/api/fs/file?path=${encodeURIComponent(join(restored.state_dir, "factory", "records.sqlite"))}`, { headers: { authorization: `Bearer ${f.token}` } });
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer()).includes(Buffer.from(exclusive.note))).toBe(false);
    } finally { copy?.stop(); f.close(); }
  });
  it("keeps Machine cleanup pending while new backups and restores exclude the fenced Assignment", async () => {
    const f = await capacityFixture();
    const copies: ReturnType<typeof createServer>[] = [];
    try {
      const deleted = await f.assignment("Offline deletion with snapshots");
      const sibling = await f.assignment("Online retained recovery");
      await f.api(`/implementations/${deleted}/runs`, { action: "work", idempotency_key: "owned-run" });
      const old = await f.api("/backups", {}).then(r => r.json());
      f.offline(true);
      const pending = await f.api(`/implementations/${deleted}/delete`, {}).then(r => r.json());
      expect(pending.condition).toBe("pending");
      expect(pending.reasons.join(" ")).toContain("owned-a");
      const recent = await f.api("/backups", {}).then(r => r.json());
      for (const snapshot of [old, recent]) {
        const result = await f.api(`/backups/${snapshot.id}/restore`, {});
        expect(result.status).toBe(201);
        const recovery = await result.json();
        const app = createServer({ port: 0, token: f.token, stateDir: recovery.state_dir, machines: false, factory: { accountDiscoveryHome: f.state } }); copies.push(app);
        const read = (id: string) => fetch(`http://localhost:${app.port}/api/factory/implementations/${id}`, { headers: { authorization: `Bearer ${f.token}` } });
        expect((await read(deleted)).status).toBe(404);
        expect((await read(sibling)).status).toBe(200);
      }
      expect((await f.api(`/implementations/${deleted}`).then(r => r.json())).implementation.deletion.reasons.join(" ")).toContain("owned-a");
      f.offline(false);
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline && (await f.api(`/implementations/${deleted}`)).status !== 404) await Bun.sleep(30);
      expect((await f.api(`/implementations/${deleted}`)).status).toBe(404);
    } finally { for (const app of copies.reverse()) app.stop(); f.close(); }
  }, 15_000);
});
