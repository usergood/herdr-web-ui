import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";
import { herdrRpc, workspaceClose, type WorkspaceCreateResult } from "./herdr/client.ts";
import type { FactoryRun } from "../shared/factory.ts";

/** Owned external repository and native workspace; every observation uses HTTP. */
export async function factoryDeliveryFixture(remote = false, reviewReports = false) {
  const root = mkdtempSync(join(tmpdir(), "saurons-delivery-"));
  const repo = join(root, "repo"); mkdirSync(repo);
  writeFileSync(join(repo, "README.md"), "Owned delivery fixture\n");
  const git = (args: string[], cwd = repo) => execFileSync("git", args, { cwd, encoding: "utf8" });
  git(["init", "-b", "main"]); git(["add", "."]);
  git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "initial"]);
  const owned: string[] = [];
  const host = createServer({ port: 0, token: remote ? "owned-delivery-host" : "", stateDir: join(root, "state"), ...(remote ? { machines: false as const } : {}), factory: { accountDiscoveryHome: root, native: {
    version: async () => "owned-delivery-fixture",
    createWorkspace: async options => { const result = await herdrRpc<WorkspaceCreateResult>("workspace.create", { ...options, focus: false }); owned.push(result.workspace.workspace_id); return result; },
    startAgent: async options => { await herdrRpc("pane.report_agent", { pane_id: options.paneId, source: "manual", agent: "codex", state: "idle" }); },
  } } });
  let offline = false;
  let reviewHead = "";
  let handoffWrite: (() => void) | null = null;
  const proxy = remote ? Bun.serve({ port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/operations/transcript") && handoffWrite) { const write = handoffWrite; handoffWrite = null; write(); }
    if (reviewReports && url.pathname.endsWith("/operations/review-evidence")) return Response.json({ head: reviewHead, source_id: "owned-external-review", content: "Owned external review passed", outcome: "passed" });
    const response = await fetch(`http://localhost:${host.port}${url.pathname}${url.search}`, request);
    const headers = new Headers(response.headers); headers.delete("content-encoding"); headers.delete("content-length");
    return new Response(response.body, { status: response.status, headers });
  } }) : null;
  const app = remote ? createServer({ port: 0, token: "", stateDir: join(root, "coordinator"), machines: false, factory: { machineEndpoint: id => id === "delivery-host" && !offline ? { url: `http://localhost:${proxy!.port}`, token: "owned-delivery-host" } : undefined } }) : host;
  const request = (path: string, body?: unknown) => fetch(`http://localhost:${app.port}/api/factory${path}`, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", "x-herdr-factory": "1" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const project = await request("/projects", { name: "Delivery Project", path: repo, machine_id: remote ? "delivery-host" : "local", provider: "codex", tracker: "app" }).then(r => r.json());
  const idea = await request("/implementations", { title: "Retained research", description: "", project_id: project.id }).then(r => r.json());
  const prefix = `/implementations/${idea.id}`;
  const start = (key = "delivery-work"): Promise<FactoryRun> => request(`${prefix}/runs`, { action: "work", idempotency_key: key }).then(r => r.json());
  return { root, repo, git, app, project, prefix, request, start, changeDuringHandoff: (write: () => void) => { handoffWrite = write; }, setReviewHead: (head: string) => { reviewHead = head; }, disconnect: () => { offline = true; }, close: async () => { app.stop(); proxy?.stop(); if (app !== host) host.stop(); for (const id of owned) await workspaceClose(id).catch(() => {}); rmSync(root, { recursive: true, force: true }); } };
}
