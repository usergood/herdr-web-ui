import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import type { AgentModelCatalog, AgentModelChoice } from "../shared/agent-models.ts";
import type { FactoryProvider } from "../shared/factory.ts";
import { currentAccountEnvironment } from "./account-execution.ts";

const effortNames: Record<string, string> = { none: "None", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Maximum" };
const identifier = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:/@+\[\]-]{0,199}$/.test(value);
type ObjectValue = Record<string, any>;

/** Initialize/read only; no thread, user input or inference request is sent. */
async function protocolModels(executable: string, cwd: string, provider: "codex" | "claude"): Promise<AgentModelChoice[]> {
  const args = provider === "codex" ? [...(currentAccountEnvironment()["CODEX_HOME"] ? ["-c", 'cli_auth_credentials_store="file"', "-c", 'forced_login_method="chatgpt"', "-c", 'model_provider="openai"'] : []), "app-server"] : ["--print", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--disable-slash-commands", "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--settings", '{"disableAllHooks":true}'];
  const child = spawn(executable, args, { cwd, env: { ...process.env, ...currentAccountEnvironment() }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const pending = new Map<number, { resolve: (value: ObjectValue) => void; reject: (error: Error) => void }>();
  let sequence = 0, bytes = 0, closed = false;
  const failure = () => { for (const task of pending.values()) task.reject(new Error("Native model catalog unavailable")); pending.clear(); };
  child.once("error", failure); child.once("close", () => { closed = true; failure(); });
  child.stdin.on("error", failure);
  const budget = (chunk: Buffer) => { bytes += chunk.length; if (bytes > 4 * 1024 * 1024) { failure(); child.kill("SIGKILL"); } };
  child.stdout.on("data", budget); child.stderr.on("data", budget);
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => {
    try {
      const incoming = JSON.parse(line);
      const message = provider === "claude" ? { id: Number(incoming.response?.request_id), result: incoming.response?.response, error: incoming.response?.subtype === "error" } : incoming;
      const task = pending.get(message.id);
      if (!task) return;
      pending.delete(message.id);
      if (message.error || !message.result || typeof message.result !== "object") task.reject(new Error("Native model catalog unavailable"));
      else task.resolve(message.result);
    } catch { failure(); child.kill("SIGKILL"); }
  });
  const deadline = setTimeout(() => { failure(); child.kill("SIGKILL"); }, 12000);
  const request = (method: string, params: ObjectValue): Promise<ObjectValue> => new Promise((resolve, reject) => {
    if (closed) { reject(new Error("Native model catalog unavailable")); return; }
    const id = ++sequence; pending.set(id, { resolve, reject });
    const message = provider === "claude" ? { type: "control_request", request_id: String(id), request: { subtype: method, ...params } } : { id, method, params };
    child.stdin.write(JSON.stringify(message) + "\n", error => { if (error) { pending.delete(id); reject(new Error("Native model catalog unavailable")); } });
  });
  try {
    const initialized = await request("initialize", provider === "codex" ? { clientInfo: { name: "saurons_eye", version: "1" }, capabilities: { experimentalApi: true } } : { hooks: {}, sdkMcpServers: [] });
    if (provider === "claude") {
      if (!Array.isArray(initialized.models)) throw new Error("Native model catalog unavailable");
      return initialized.models.filter((entry: ObjectValue) => entry && identifier(entry.resolvedModel ?? entry.value)).map((entry: ObjectValue) => {
        const id = entry.resolvedModel ?? entry.value;
        const reasoning = (Array.isArray(entry.supportedEffortLevels) ? [...new Set<string>(entry.supportedEffortLevels.filter(identifier))] : []).map(id => ({ id, name: effortNames[id] ?? id }));
        return { id, name: typeof entry.displayName === "string" ? entry.displayName.slice(0, 200) : id, reasoning, default_reasoning: null };
      });
    }
    child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
    const models: AgentModelChoice[] = []; const cursors = new Set<string>(); let cursor: string | undefined;
    for (let page = 0; page < 32; page++) {
      const result = await request("model/list", { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(result.data)) throw new Error("Native model catalog unavailable");
      for (const entry of result.data) {
        if (!entry || entry.hidden || !identifier(entry.model ?? entry.id) || !Array.isArray(entry.supportedReasoningEfforts)) continue;
        const reasoning = [...new Set<string>(entry.supportedReasoningEfforts.map((effort: ObjectValue) => effort?.reasoningEffort).filter(identifier))].map(id => ({ id, name: effortNames[id] ?? id }));
        const id = entry.model ?? entry.id;
        if (models.some(model => model.id === id)) continue;
        models.push({ id, name: typeof entry.displayName === "string" ? entry.displayName.slice(0, 200) : id, reasoning, default_reasoning: reasoning.some(effort => effort.id === entry.defaultReasoningEffort) ? entry.defaultReasoningEffort : null });
      }
      if (result.nextCursor === null || result.nextCursor === undefined) return models;
      if (typeof result.nextCursor !== "string" || cursors.has(result.nextCursor)) throw new Error("Native model catalog pagination unavailable");
      cursor = result.nextCursor; cursors.add(cursor);
    }
    throw new Error("Native model catalog exceeds page budget");
  } finally {
    clearTimeout(deadline); lines.close();
    if (!closed) { child.kill("SIGKILL"); await new Promise<void>(resolve => child.once("close", () => resolve())); }
  }
}

/** A private loopback metadata server, never the user's existing OpenCode service. */
async function opencodeModels(executable: string, cwd: string): Promise<AgentModelCatalog> {
  const environment = { ...process.env, ...currentAccountEnvironment() };
  const version = (await promisify(execFile)(executable, ["--version"], { cwd, env: environment, timeout: 4000, maxBuffer: 65536 })).stdout;
  const generation = Number(version.match(/(?:^|\s)(\d+)\.\d+\.\d+/)?.[1]);
  if (!generation || generation > 2) throw new Error("Unsupported OpenCode catalog generation");
  const password = randomUUID();
  const child = spawn(executable, ["serve", "--hostname", "127.0.0.1", "--port", "0"], { cwd, env: { ...environment, OPENCODE_SERVER_USERNAME: "opencode", OPENCODE_SERVER_PASSWORD: password }, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
  let closed = false, bytes = 0, output = "";
  const stop = () => { if (closed) return; try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { child.kill("SIGKILL"); } };
  let rejectAddress!: (error: Error) => void;
  const address = new Promise<string>((resolve, reject) => {
    rejectAddress = reject;
    child.once("error", () => reject(new Error("Native model catalog unavailable")));
    child.once("close", () => { closed = true; reject(new Error("Native model catalog unavailable")); });
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length; if (bytes > 1024 * 1024) { stop(); reject(new Error("Native model catalog exceeds output budget")); return; }
      output += chunk.toString(); const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
      if (match && Number(match[1]) > 0 && Number(match[1]) <= 65535) resolve(match[0]);
    });
    child.stderr.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 1024 * 1024) { stop(); reject(new Error("Native model catalog exceeds output budget")); } });
  });
  const deadline = setTimeout(() => { rejectAddress(new Error("Native model catalog timed out")); stop(); }, 12000);
  try {
    const origin = await address;
    const response = await fetch(origin + (generation === 2 ? `/api/model?location=${encodeURIComponent(JSON.stringify({ directory: cwd }))}` : "/provider"), { headers: { authorization: "Basic " + Buffer.from("opencode:" + password).toString("base64") }, redirect: "error", signal: AbortSignal.timeout(6000) });
    if (!response.ok) throw new Error("Native model catalog unavailable");
    const reader = response.body!.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length; if (size > 4 * 1024 * 1024) throw new Error("Native model catalog exceeds output budget"); chunks.push(chunk.value); } }
    finally { await reader.cancel(); }
    const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (generation === 2 && realpathSync(data.location?.directory) !== cwd) throw new Error("Native model catalog belongs to another directory");
    const entries = generation === 2 ? data.data : Array.isArray(data.all) && Array.isArray(data.connected) ? data.all.filter((provider: ObjectValue) => data.connected.includes(provider.id)).flatMap((provider: ObjectValue) => Object.values(provider.models ?? {}).map((model: unknown) => ({ ...(model as ObjectValue), providerID: provider.id }))) : null;
    if (!Array.isArray(entries) || entries.length > 4096) throw new Error("Native model catalog unavailable");
    const models: AgentModelChoice[] = [];
    for (const entry of entries) {
      const id = `${entry.providerID}/${entry.id}`;
      if (entry.disabled || !identifier(id) || models.some(model => model.id === id)) continue;
      const variants = Array.isArray(entry.variants) ? entry.variants.map((variant: ObjectValue) => variant?.id) : entry.variants && typeof entry.variants === "object" ? Object.keys(entry.variants) : [];
      const reasoning = [...new Set<string>(variants.filter(identifier))].map(id => ({ id, name: effortNames[id] ?? id }));
      models.push({ id, name: typeof entry.name === "string" ? entry.name.slice(0, 200) : id, reasoning, default_reasoning: null });
    }
    return { protocol: 1, provider: "opencode", models, problem: models.length ? null : "This CLI reported no selectable models", reasoning_format: generation === 2 ? "model_suffix" : "agent_config" };
  } finally {
    clearTimeout(deadline); stop(); if (!closed) await new Promise<void>(resolve => child.once("close", () => resolve()));
  }
}

export async function readAgentModelCatalog(provider: FactoryProvider, cwd: string): Promise<AgentModelCatalog> {
  const unavailable: AgentModelCatalog = { protocol: 1, provider, models: [], problem: "This CLI's model catalog is unavailable. Use its native default or refresh after signing in." };
  const executable = Bun.which(provider);
  if (!executable) return unavailable;
  try {
    if (provider === "opencode") return await opencodeModels(executable, cwd);
    const models = await protocolModels(executable, cwd, provider);
    return models.length ? { protocol: 1, provider, models, problem: null } : unavailable;
  } catch { return unavailable; }
}
