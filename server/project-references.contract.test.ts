import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type ServerInstance } from "./index.ts";
import { herdrRpc, workspaceClose, workspaceCreate } from "./herdr/client.ts";

describe("Project references through HTTP", () => {
  const roots: string[] = [];
  const apps: ServerInstance[] = [];
  const nativeWorkspaces: string[] = []; let purposeWorkspace: string;
  beforeAll(async () => { purposeWorkspace = (await workspaceCreate({ cwd: tmpdir(), label: "herdr-web-ui-test-project-references" })).workspace.workspace_id; });
  afterAll(async () => { await workspaceClose(purposeWorkspace); });
  afterEach(async () => { for (const id of nativeWorkspaces.splice(0)) await workspaceClose(id).catch(() => {}); for (const app of apps.splice(0)) app.stop(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
  function fixture(endpoint?: (id: string) => { url: string; token: string } | undefined) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "project-references-"))); roots.push(root);
    const repo = join(root, "repo"); mkdirSync(repo);
    execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
    writeFileSync(join(repo, "README.md"), "# Owned reference fixture\n");
    execFileSync("git", ["add", "README.md"], { cwd: repo });
    execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "fixture"], { cwd: repo, stdio: "ignore" });
    const state = join(root, "state");
    const start = () => { const app = createServer({ port: 0, stateDir: state, machines: false, factory: { machineEndpoint: endpoint, native: {
      version: async () => "reference-contract-fixture",
      createWorkspace: async (options, socket) => { const created = await workspaceCreate(options, socket); nativeWorkspaces.push(created.workspace.workspace_id); return created; },
      startAgent: async (options) => { await herdrRpc("pane.report_agent", { pane_id: options.paneId, source: "manual", agent: "codex", state: "idle" }); },
    } } }); apps.push(app); return app; };
    let app = start();
    const request = (path: string, body?: unknown) => fetch(`http://localhost:${app.port}/api/factory${path}`, { method: body === undefined ? "GET" : "POST", headers: body === undefined ? {} : { "content-type": "application/json", "x-herdr-factory": "1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const project = async (name: string) => { const response = await request("/projects", { name, path: repo, machine_id: "local", provider: "codex", tracker: "app" }); expect(response.status).toBe(201); return await response.json() as { id: string }; };
    return { root, repo, state, request, project, restart: () => { app.stop(); apps.splice(apps.indexOf(app), 1); app = start(); } };
  }
  it("shares a retained guide within one Project and preserves it after restart", async () => {
    const f = fixture(); const a = await f.project("Project A"); const b = await f.project("Project B");
    const initial = await f.request(`/projects/${a.id}/references`);
    expect(initial.status).toBe(200);
    const library = await initial.json() as { revision: string; entries: unknown[] };
    expect(library.entries).toEqual([]);
    const uploaded = await f.request(`/projects/${a.id}/references`, { expected_revision: library.revision, name: "payments.md", title: "Payment rules", media_type: "text/markdown", content_base64: Buffer.from("# Payment rules\nKeep refunds idempotent.\n").toString("base64"), usage_note: "Read before changing refunds", read_policy: "always", caption: "" });
    expect(uploaded.status).toBe(201);
    const reference = await uploaded.json() as { id: string; hash: string; version: number };
    expect(reference.version).toBe(1);
    f.restart();
    const retained = await (await f.request(`/projects/${a.id}/references`)).json() as { entries: { id: string; title: string; usage_note: string }[] };
    expect(retained.entries).toMatchObject([{ id: reference.id, title: "Payment rules", usage_note: "Read before changing refunds" }]);
    expect(await (await f.request(`/projects/${a.id}/references/${reference.id}/source`)).text()).toBe("# Payment rules\nKeep refunds idempotent.\n");
    expect((await (await f.request(`/projects/${b.id}/references`)).json()).entries).toEqual([]);
    expect((await f.request(`/projects/${b.id}/references/${reference.id}/source`)).status).toBe(404);
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: f.repo, encoding: "utf8" })).toBe("");
  });
  it("versions reference guidance, rejects stale changes, and offers a reusable template", async () => {
    const f = fixture(); const project = await f.project("Payments");
    const templateResponse = await f.request("/reference-template"); expect(templateResponse.status).toBe(200);
    const template = await templateResponse.json() as { name: string; content: string };
    for (const heading of ["## Purpose", "## When to use", "## Required guidance", "## Workflow", "## Examples", "## Verification", "## Related references"]) expect(template.content).toContain(heading);
    const libraryPath = `/projects/${project.id}/references`;
    const initial = await (await f.request(libraryPath)).json();
    const body = { expected_revision: initial.revision, name: "guide.md", title: "Refund guide", media_type: "text/markdown", content_base64: Buffer.from("First guidance").toString("base64"), usage_note: "Before refunds", read_policy: "always", caption: "" };
    const first = await (await f.request(libraryPath, body)).json();
    expect((await f.request(libraryPath, { ...body, content_base64: Buffer.from("Wrong stale overwrite").toString("base64") })).status).toBe(409);
    const current = await (await f.request(libraryPath)).json();
    const secondResponse = await f.request(libraryPath, { ...body, expected_revision: current.revision, content_base64: Buffer.from("Second guidance").toString("base64"), usage_note: "Before refunds and chargebacks" });
    expect(secondResponse.status).toBe(201); const second = await secondResponse.json();
    expect(second).toMatchObject({ reference_id: first.reference_id, version: 2, usage_note: "Before refunds and chargebacks" });
    expect(await (await f.request(`${libraryPath}/${first.id}/source`)).text()).toBe("First guidance");
    const latest = await (await f.request(libraryPath)).json(); expect(latest.entries.map((entry: { id: string }) => entry.id)).toEqual([second.id]);
    expect((await f.request(`${libraryPath}/${second.id}/remove`, { expected_revision: initial.revision })).status).toBe(409);
    expect((await f.request(`${libraryPath}/${second.id}/remove`, { expected_revision: latest.revision })).status).toBe(200);
    expect((await (await f.request(libraryPath)).json()).entries).toEqual([]);
    expect(await (await f.request(`${libraryPath}/${second.id}/source`)).text()).toBe("Second guidance");
    const backup = await (await f.request("/backups", {})).json(); expect(backup.blobs).toHaveLength(2);
  });
  it("prepares a pinned Codex index outside Git without changing the checkout", async () => {
    const f = fixture(); const project = await f.project("Codex references"); const path = `/projects/${project.id}/references`;
    const library = await (await f.request(path)).json();
    const guide = await (await f.request(path, { expected_revision: library.revision, name: "guidance.md", title: "Refund policy", media_type: "text/markdown", content_base64: Buffer.from("Refund invariant: REFUND-713").toString("base64"), usage_note: "Before any refund change", read_policy: "always", caption: "" })).json();
    const selected = await (await f.request(path)).json();
    const response = await f.request(`${path}/prepare`, { machine_id: "local", expected_revision: selected.revision }); expect(response.status).toBe(200);
    const context = await response.json(); expect(context).toMatchObject({ project_id: project.id, machine_id: "local", revision: selected.revision });
    expect(context.index_path.startsWith(f.repo + "/")).toBe(false);
    const index = readFileSync(context.index_path, "utf8"); expect(index).toContain("Refund policy"); expect(index).toContain("Before any refund change"); expect(index).toContain("Always read");
    const prepared = await f.request(`${path}/prepare`, { machine_id: "local", expected_revision: selected.revision }); expect((await prepared.json()).index_path).toBe(context.index_path);
    expect(context.prompt).toContain(context.index_path); expect(context.prompt).toContain("repository instructions");
    const entryPath = join(context.index_path, "..", guide.id + ".md"); expect(readFileSync(entryPath, "utf8")).toBe("Refund invariant: REFUND-713");
    const updated = await f.request(path, { expected_revision: selected.revision, name: "guidance.md", title: "Refund policy", media_type: "text/markdown", content_base64: Buffer.from("Refund invariant: REFUND-920").toString("base64"), usage_note: "New policy", read_policy: "always", caption: "" }); expect(updated.status).toBe(201);
    expect((await f.request(`${path}/prepare`, { machine_id: "local", expected_revision: selected.revision })).status).toBe(409);
    expect(readFileSync(entryPath, "utf8")).toBe("Refund invariant: REFUND-713");
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: f.repo, encoding: "utf8" })).toBe("");
  });
  it("freezes Project references in a Codex Run and supplies the same index to a review worker", async () => {
    const f = fixture(); const project = await f.project("Frozen references"); const path = `/projects/${project.id}/references`;
    const library = await (await f.request(path)).json();
    const guide = { name: "workflow.md", title: "Refund workflow", media_type: "text/markdown", content_base64: Buffer.from("Original owner workflow").toString("base64"), usage_note: "Read before starting", read_policy: "always", caption: "" };
    await f.request(path, { ...guide, expected_revision: library.revision }); const selected = await (await f.request(path)).json();
    const idea = await (await f.request("/implementations", { title: "Read frozen guidance", description: "" })).json();
    await f.request(`/implementations/${idea.id}/configure`, { project_id: project.id });
    const response = await f.request(`/implementations/${idea.id}/runs`, { action: "grill-with-docs", idempotency_key: "owned-codex-references" }); expect(response.status).toBe(202);
    const run = await response.json(); expect(run.condition).toBe("working"); expect(run.manifest.project_references.revision).toBe(selected.revision);
    const rootContext = JSON.parse(readFileSync(join(run.worktree, ".saurons-eye-context.json"), "utf8"));
    expect(rootContext.project_reference_context.revision).toBe(selected.revision);
    await f.request(path, { ...guide, expected_revision: selected.revision, content_base64: Buffer.from("New owner workflow").toString("base64") });
    const workerResponse = await f.request(`/runs/${run.id}/workers`, { role: "standards", idempotency_key: "owned-reference-review" }); expect(workerResponse.status).toBe(200);
    const worker = await workerResponse.json(); expect(worker.condition).toBe("working");
    const childContext = JSON.parse(readFileSync(join(worker.worktree, ".saurons-eye-context.json"), "utf8"));
    expect(childContext.project_reference_context.index_path).toBe(rootContext.project_reference_context.index_path);
    expect(childContext.project_reference_context.revision).toBe(selected.revision);
    expect(readFileSync(join(rootContext.project_reference_context.index_path, "..", selected.entries[0].id + ".md"), "utf8")).toBe("Original owner workflow");
    expect((await (await f.request(`/implementations/${idea.id}`)).json()).runs[0].manifest.project_references.revision).toBe(selected.revision);
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: f.repo, encoding: "utf8" })).toBe("");
    await f.request(`/runs/${run.id}/stop`, {});
  });
  it("rejects unsafe inputs and changed caches, and restores retained references without enabling preparation", async () => {
    const f = fixture(); const project = await f.project("Reference validation"); const path = `/projects/${project.id}/references`;
    const library = await (await f.request(path)).json();
    const guide = { expected_revision: library.revision, name: "safe.md", title: "Safe guide", media_type: "text/markdown", content_base64: Buffer.from("Original canonical text").toString("base64"), usage_note: "Read for this task", read_policy: "always", caption: "" };
    expect((await f.request(path, { ...guide, name: "../escape.md" })).status).toBe(400);
    expect((await f.request(path, { ...guide, media_type: "application/pdf" })).status).toBe(400);
    expect((await f.request(path, { ...guide, read_policy: ["always"] })).status).toBe(400);
    const saved = await (await f.request(path, guide)).json(); const selected = await (await f.request(path)).json();
    const context = await (await f.request(`${path}/prepare`, { machine_id: "local", expected_revision: selected.revision })).json();
    const cached = join(context.index_path, "..", saved.id + ".md"); writeFileSync(cached, "Unexpected changed cache");
    expect((await f.request(`${path}/prepare`, { machine_id: "local", expected_revision: selected.revision })).status).toBe(409);
    expect(readFileSync(cached, "utf8")).toBe("Unexpected changed cache");
    expect(await (await f.request(`${path}/${saved.id}/source`)).text()).toBe("Original canonical text");
    const backup = await (await f.request("/backups", {})).json(); const restored = await (await f.request(`/backups/${backup.id}/restore`, {})).json();
    const copy = createServer({ port: 0, stateDir: restored.state_dir, machines: false }); apps.push(copy);
    expect((await (await fetch(`http://localhost:${copy.port}/api/factory${path}`)).json()).entries).toMatchObject([{ id: saved.id }]);
    const preparation = await fetch(`http://localhost:${copy.port}/api/factory${path}/prepare`, { method: "POST", headers: { "content-type": "application/json", "x-herdr-factory": "1" }, body: JSON.stringify({ machine_id: "local", expected_revision: selected.revision }) });
    expect(preparation.status).toBe(409);
  });
  it("prepares verified bridge-local files and refuses a bridge that cannot deliver Run references", async () => {
    let gateway: ReturnType<typeof Bun.serve>; let host: ServerInstance; let legacy = false;
    const token = "owned-reference-bridge-fixture";
    const f = fixture((id) => id === "reference-host" ? { url: `http://localhost:${gateway.port}`, token } : undefined);
    execFileSync("git", ["remote", "add", "origin", "https://example.invalid/project-references.git"], { cwd: f.repo });
    const clone = join(f.root, "remote-repo"); execFileSync("git", ["clone", "--local", f.repo, clone], { stdio: "ignore" });
    execFileSync("git", ["remote", "set-url", "origin", "https://example.invalid/project-references.git"], { cwd: clone });
    host = createServer({ port: 0, stateDir: join(f.root, "host-state"), token, machines: false, factory: { native: { version: async () => "reference-contract-fixture", startAgent: async () => {}, createWorkspace: async (options, socket) => { const created = await workspaceCreate(options, socket); nativeWorkspaces.push(created.workspace.workspace_id); return created; } } } }); apps.push(host);
    gateway = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
      const url = new URL(request.url); const response = await fetch(`http://localhost:${host.port}${url.pathname}${url.search}`, { method: request.method, headers: request.headers, ...(request.method === "GET" ? {} : { body: await request.text() }) });
      if (legacy && url.pathname.endsWith("/capabilities")) { const capabilities = await response.json(); delete capabilities.project_reference_protocol; return Response.json(capabilities); }
      return response;
    } });
    try {
      const project = await f.project("Bridge library"); expect((await f.request(`/projects/${project.id}/checkouts`, { machine_id: "reference-host", path: clone })).status).toBe(201);
      const path = `/projects/${project.id}/references`; const initial = await (await f.request(path)).json();
      const saved = await (await f.request(path, { expected_revision: initial.revision, name: "bridge.md", title: "Bridge guide", media_type: "text/markdown", content_base64: Buffer.from("Machine-local retained guidance").toString("base64"), usage_note: "Read on the selected Machine", read_policy: "always", caption: "" })).json(); const library = await (await f.request(path)).json();
      const prepared = await f.request(`${path}/prepare`, { expected_revision: library.revision, machine_id: "reference-host" }); expect(prepared.status).toBe(200); const context = await prepared.json();
      expect(context.machine_id).toBe("reference-host"); expect(context.index_path.startsWith(join(f.root, "host-state") + "/")).toBe(true);
      expect(readFileSync(join(context.index_path, "..", saved.id + ".md"), "utf8")).toBe("Machine-local retained guidance");
      const idea = await (await f.request("/implementations", { title: "Do not lose remote references", description: "" })).json(); await f.request(`/implementations/${idea.id}/configure`, { project_id: project.id, machine_id: "reference-host" }); legacy = true;
      const refused = await f.request(`/implementations/${idea.id}/runs`, { action: "grill-with-docs", idempotency_key: "legacy-bridge-must-refuse" }); expect(refused.status).toBe(409); expect((await refused.json()).error.code).toBe("factory_bridge_incompatible");
      expect((await (await f.request(`/implementations/${idea.id}`)).json()).runs).toEqual([]);
      host.stop(); apps.splice(apps.indexOf(host), 1);
      expect(readFileSync(join(context.index_path, "..", saved.id + ".md"), "utf8")).toBe("Machine-local retained guidance");
      expect(execFileSync("git", ["status", "--porcelain"], { cwd: clone, encoding: "utf8" })).toBe("");
    } finally { gateway.stop(true); }
  });
});
