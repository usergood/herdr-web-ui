import { describe, expect, it } from "bun:test";
import { capacityFixture } from "../scripts/factory-capacity-fixture.ts";

describe("Specification acceptance through authenticated HTTP", () => {
  it("accepts the presented revision once without chat or execution capacity and survives restart", async () => {
    const f = await capacityFixture();
    try {
      await f.api("/settings", { max_agents: 1 });
      const occupied = await f.assignment("Occupied");
      await f.api(`/implementations/${occupied}/runs`, { action: "work", idempotency_key: "occupied" });
      const id = await f.assignment("Presented Specification");
      const prefix = `/implementations/${id}`;
      const spec = await f.api(`${prefix}/specifications`, { content: "Build the approved behavior" }).then(r => r.json());
      const accept = () => f.api(`${prefix}/specification-acceptance`, { specification_id: spec.id, hash: spec.hash, source: "button" });
      const response = await accept(); expect(response.status).toBe(201);
      const approval = await response.json();
      expect(approval).toMatchObject({ kind: "specification", revision: spec.id, provenance: { kind: "button", specification_hash: spec.hash } });
      f.restart();
      expect((await accept().then(r => r.json())).id).toBe(approval.id);
      const detail = await f.api(prefix).then(r => r.json());
      expect(detail.approvals).toHaveLength(1);
      expect(detail.runs).toHaveLength(0);
      expect(detail.messages).toHaveLength(1); // Initial Assignment description only.
      const newer = await f.api(`${prefix}/specifications`, { content: "A different revision" }).then(r => r.json());
      expect((await accept()).status).toBe(409);
      expect(newer.id).not.toBe(spec.id);
    } finally { f.close(); }
  });
  it("retains explicit owner chat acceptance and its source once, rejecting stale or imported authority", async () => {
    const f = await capacityFixture();
    try {
      const id = await f.assignment("Chat acceptance"); const prefix = `/implementations/${id}`;
      const spec = await f.api(`${prefix}/specifications`, { content: "Present this exact revision" }).then(r => r.json());
      const reply = (content: string, key: string = crypto.randomUUID()) => f.api(`${prefix}/specification-acceptance`, { specification_id: spec.id, hash: spec.hash, source: "owner_chat", content, idempotency_key: key });
      for (const text of ['> accepted', '"accepted"', 'I accepted another proposal', 'accepted if you change it', 'not accepted', 'Confirmed']) {
        expect((await reply(text)).status).toBe(201);
        expect((await f.api(prefix).then(r => r.json())).approvals).toHaveLength(0);
      }
      const chat = (await f.api(prefix).then(r => r.json())).chats[0];
      await f.api(`${prefix}/messages`, { chat_id: chat.id, role: "agent", content: "accepted", source_id: "imported-agent", sequence: 0 });
      expect((await f.api(prefix).then(r => r.json())).approvals).toHaveLength(0);
      await f.api(`${prefix}/messages`, { chat_id: chat.id, role: "agent", content: "accepted", source_id: `specification:${spec.id}:agent-collision`, sequence: 0 });
      expect((await reply("accepted", "agent-collision")).status).toBe(409);
      expect((await f.api(prefix).then(r => r.json())).approvals).toHaveLength(0);
      const response = await reply("accepted", "owner-accepts"); expect(response.status).toBe(201);
      const result = await response.json();
      expect(result.approval).toMatchObject({ revision: spec.id, provenance: { kind: "owner_chat", specification_hash: spec.hash, message_id: result.message.id } });
      f.restart();
      expect((await reply("accepted", "owner-accepts").then(r => r.json())).message.id).toBe(result.message.id);
      expect((await reply("different text", "owner-accepts")).status).toBe(409);
      expect((await f.api(prefix).then(r => r.json())).approvals).toHaveLength(1);
      await f.api(`${prefix}/specifications`, { content: "Superseding Specification" });
      expect((await reply("accepted", "stale")).status).toBe(409);
    } finally { f.close(); }
  });

  it("attributes a native accepted reply only to the exact presented Specification", async () => {
    const f = await capacityFixture();
    try {
      const id = await f.assignment("Native acceptance"); const prefix = `/implementations/${id}`;
      const run = await f.api(`${prefix}/runs`, { action: "to-spec", idempotency_key: "native-spec" }).then(r => r.json());
      const spec = await f.agent(run.id, "specification", { content: "An exact native Specification\n" }).then(r => r.json());
      const time = (offset: number) => new Date(Date.parse(spec.created_at) + offset).toISOString();
      const assistant = { role: "assistant" as const, ts: time(1000), parts: [{ kind: "text" as const, text: `Specification ${spec.id}, SHA-256 ${spec.hash}\n\n${spec.content}` }] };
      const owner = { role: "user" as const, ts: time(2000), parts: [{ kind: "text" as const, text: "accepted" }] };
      const sync = (turns: any[], version: string) => {
        f.setTranscript({ source_id: "owned-native-spec", version, cursor: null, turns });
        return f.api(`/runs/${run.id}/import-conversation`, {});
      };
      for (const [index, turns] of [[owner], [assistant, { ...owner, role: "assistant" }], [assistant, { ...owner, parts: [{ kind: "text", text: '> accepted' }] }], [{ ...assistant, parts: [{ kind: "text", text: "An unrelated proposal" }] }, owner]].entries()) {
        expect((await sync(turns, `negative-${index}`)).status).toBe(200);
        expect((await f.api(prefix).then(r => r.json())).approvals).toHaveLength(0);
      }
      const presented = { ...assistant, ts: time(-1000), end_ts: time(1000), parts: [
        { kind: "thinking", text: "Draft the complete Specification" },
        { kind: "tool", name: "exec_command", summary: "Submit Specification", input: "owned fixture", output: "owned submitted ID and hash" },
        ...assistant.parts,
      ] };
      const snapshot = await sync([presented, owner], "accepted").then(r => r.json());
      let detail = await f.api(prefix).then(r => r.json());
      expect(detail.approvals).toEqual([expect.objectContaining({ revision: spec.id, provenance: { kind: "native_chat", specification_hash: spec.hash, run_id: run.id, snapshot_id: snapshot.id, source_id: "owned-native-spec", turn_ts: owner.ts } })]);
      await sync([presented, owner], "accepted"); f.restart();
      await f.api(`${prefix}/specifications`, { content: "Superseding revision" });
      await sync([assistant, owner], "stale");
      detail = await f.api(prefix).then(r => r.json());
      expect(detail.approvals).toHaveLength(1);
    } finally { f.close(); }
  });

  it("retains a later attributable answer while an older confirmation remains explicitly pending", async () => {
    const f = await capacityFixture();
    try {
      const id = await f.assignment("Pending confirmation"); const prefix = `/implementations/${id}`;
      const run = await f.api(`${prefix}/runs`, { action: "work", idempotency_key: "questions" }).then(r => r.json());
      const confirmation = await f.agent(run.id, "question", { question: "Confirm the earlier proposal", answer_kind: "confirmation" }).then(r => r.json());
      const deadline = Date.now() + 1000;
      while (Date.now() <= Date.parse(confirmation.created_at)) { if (Date.now() > deadline) throw new Error("Fixture clock did not advance"); await Bun.sleep(1); }
      const question = await f.agent(run.id, "question", { question: "Which final behavior?" }).then(r => r.json());
      f.setTranscript({ source_id: "owned-questions", version: "answer-v1", cursor: null, turns: [{ role: "user", ts: new Date(Date.parse(question.created_at) + 1000).toISOString(), parts: [{ kind: "text", text: "Retain the final behavior" }] }] });
      await f.api(`/runs/${run.id}/import-conversation`, {});
      const detail = await f.api(prefix).then(r => r.json());
      expect(detail.questions).toEqual([expect.objectContaining({ id: confirmation.id, answer: null }), expect.objectContaining({ id: question.id, answer: "Retain the final behavior" })]);
      expect(detail.approvals).toHaveLength(0);
      expect((await f.agent(run.id, "consume", { revision: detail.question_revision })).status).toBe(409);
      expect((await f.api(`${prefix}/approvals`, { kind: "shared_understanding", revision: detail.question_revision, scope: "Explicit owner confirmation of the answered context" })).status).toBe(201);
      const answered = await f.api(prefix).then(r => r.json());
      expect((await f.agent(run.id, "consume", { revision: answered.question_revision })).status).toBe(200);
    } finally { f.close(); }
  });

  it("does not reuse a Specification decision as an answer to an earlier text question", async () => {
    const f = await capacityFixture();
    try {
      const id = await f.assignment("Separate decisions"); const prefix = `/implementations/${id}`;
      const run = await f.api(`${prefix}/runs`, { action: "to-spec", idempotency_key: "separate-decisions" }).then(r => r.json());
      const question = await f.agent(run.id, "question", { question: "Which optional follow-up?" }).then(r => r.json());
      const spec = await f.agent(run.id, "specification", { content: "The presented scope" }).then(r => r.json());
      const time = (offset: number) => new Date(Date.parse(spec.created_at) + offset).toISOString();
      f.setTranscript({ source_id: "owned-separate", version: "v1", cursor: null, turns: [
        { role: "assistant", ts: time(1000), parts: [{ kind: "text", text: `Specification ${spec.id}, SHA-256 ${spec.hash}\n\n${spec.content}` }] },
        { role: "user", ts: time(2000), parts: [{ kind: "text", text: "accepted" }] },
      ] });
      for (let repeat = 0; repeat < 2; repeat++) {
        await f.api(`/runs/${run.id}/import-conversation`, {});
        const detail = await f.api(prefix).then(r => r.json());
        expect(detail.approvals).toHaveLength(1);
        expect(detail.questions.find((q: { id: string }) => q.id === question.id).answer).toBeNull();
      }
    } finally { f.close(); }
  });

  it("requires owner authentication and origin checks and rejects claimed imported authority", async () => {
    const f = await capacityFixture();
    try {
      const id = await f.assignment("Owner authority"); const prefix = `/implementations/${id}`;
      const spec = await f.api(`${prefix}/specifications`, { content: "An owner-only decision" }).then(r => r.json());
      const body = { specification_id: spec.id, hash: spec.hash, source: "button" };
      const url = `http://localhost:${f.app.port}/api/factory${prefix}/specification-acceptance`;
      expect((await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-herdr-factory": "1" }, body: JSON.stringify(body) })).status).toBe(401);
      expect((await fetch(url, { method: "POST", headers: { authorization: `Bearer ${f.token}`, origin: "https://unowned.invalid", "content-type": "application/json", "x-herdr-factory": "1" }, body: JSON.stringify(body) })).status).toBe(403);
      for (const extra of [{ source: "native_chat" }, { role: "agent" }, { source_id: "imported" }, { hash: "stale-hash" }]) {
        const response = await f.api(`${prefix}/specification-acceptance`, { ...body, ...extra });
        expect(response.ok).toBe(false);
      }
      expect((await f.api(prefix).then(r => r.json())).approvals).toHaveLength(0);
      const decisions = await Promise.all([f.api(`${prefix}/specification-acceptance`, body), f.api(`${prefix}/specification-acceptance`, body)]);
      expect((await decisions[0]!.json()).id).toBe((await decisions[1]!.json()).id);
      expect((await f.api(prefix).then(r => r.json())).approvals).toHaveLength(1);
    } finally { f.close(); }
  });

});


it("explicit owner acceptance retains older scoped approvals and records automatic authority separately", async () => {
  const f = await capacityFixture();
  try {
    const id = await f.assignment("Existing scoped decision"); const prefix = `/implementations/${id}`;
    const specification = await f.api(prefix + "/specifications", { content: "Present the existing bounded deliverable" }).then(response => response.json());
    const legacy = await f.api(prefix + "/approvals", { kind: "specification", revision: specification.id, scope: "Previously reviewed bounded plan" }).then(response => response.json());
    const approval = await f.api(prefix + "/specification-acceptance", { specification_id: specification.id, hash: specification.hash, source: "button" }).then(response => response.json());
    expect(approval).toMatchObject({ automatic_execution: true, provenance: { kind: "button", specification_hash: specification.hash } });
    expect(approval.id).not.toBe(legacy.id);
    const detail = await f.api(prefix).then(response => response.json());
    expect(detail.approvals).toContainEqual(legacy);
    expect(detail.automatic_planning).toContainEqual(expect.objectContaining({ approval_id: approval.id, specification_id: specification.id }));
  } finally { f.close(); }
});
