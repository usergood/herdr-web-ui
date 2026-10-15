import { execFile, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AccountService } from "../shared/accounts.ts";
import { FactoryError } from "./factory-host.ts";
import { isAccountHistory } from "./account-history.ts";

export interface AccountTool { executable: string; args?: string[] }
export type AccountTools = Partial<Record<AccountService, AccountTool>>;

function sealCredentialFiles(directory: string): void {
  let count = 0;
  function visit(path: string, depth: number): void {
    if (++count > 2000 || depth > 5) throw new FactoryError("account_storage_unverified", "Native credential storage exceeds the private verification budget", 409);
    const stat = lstatSync(path); if (stat.isSymbolicLink()) throw new FactoryError("account_storage_unverified", "Native credentials must stay in the profile's private storage", 409);
    if (stat.isDirectory()) {
      chmodSync(path, 0o700);
      for (const name of readdirSync(path)) if (!isAccountHistory(name)) visit(join(path, name), depth + 1);
    } else if (stat.isFile()) { if (stat.nlink !== 1) throw new FactoryError("account_storage_unverified", "Preserve linked native credential material for operator recovery", 409); chmodSync(path, 0o600); }
  }
  visit(directory, 0);
}

/** Native credential selection is process-scoped; another service's credential is not inherited. */
export function accountProcessEnvironment(service: AccountService, directory: string): Record<string, string> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name, value]) => value !== undefined && !/(?:^GH_|^GITHUB_|^CODEX_|^CLAUDE_|^ANTHROPIC_|^OPENAI_|^CLOUDFLARE_|^WRANGLER_|_TOKEN$|_API_KEY$|_SECRET$|_PASSWORD$|_PRIVATE_KEY$)/.test(name))) as Record<string, string>;
  if (service === "github") { env["GH_CONFIG_DIR"] = directory; env["GH_HOST"] = "github.com"; }
  if (service === "codex") env["CODEX_HOME"] = directory;
  if (service === "claude") env["CLAUDE_CONFIG_DIR"] = directory;
  if (service === "cf" || service === "wrangler") env["XDG_CONFIG_HOME"] = directory;
  // Wrangler prefers a legacy ~/.wrangler even over XDG_CONFIG_HOME. Its native
  // process gets an isolated home so a pre-existing global login cannot win.
  if (service === "wrangler") { env["HOME"] = directory; env["USERPROFILE"] = directory; }
  return env;
}

export class NativeAccountTools {
  private readonly children = new Set<ChildProcess>();
  readonly genuine: boolean;
  constructor(private readonly tools: AccountTools = {}) { this.genuine = Object.keys(tools).length === 0; }
  environment(service: AccountService, directory: string): Record<string, string> {
    const env = accountProcessEnvironment(service, directory);
    if (service === "github" && !this.tools.github) {
      try {
        const hosts = Bun.YAML.parse(readFileSync(join(directory, "hosts.yml"), "utf8")) as Record<string, { user?: string; oauth_token?: string; users?: Record<string, { oauth_token?: string }> }>;
        const host = hosts["github.com"]; const token = host?.user && host.users?.[host.user]?.oauth_token || host?.oauth_token;
        if (typeof token !== "string" || !/^[a-zA-Z0-9_]{20,256}$/.test(token)) throw new Error();
        env["GH_TOKEN"] = token;
      } catch { throw new FactoryError("account_file_login_required", "Finish this profile's private file-based GitHub sign-in before verification", 409); }
    }
    return env;
  }
  stop(): void { for (const child of this.children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
  tool(service: AccountService): AccountTool {
    const executable = this.tools[service] ?? (() => { const path = Bun.which(service === "github" ? "gh" : service); return path ? { executable: path } : undefined; })();
    if (!executable) throw new FactoryError("account_tool_missing", "Install the selected native CLI on this Machine before setting up its account", 409);
    return executable;
  }
  async json(service: AccountService, args: string[], directory: string, maxBuffer = 64 * 1024): Promise<unknown> {
    const tool = this.tool(service);
    try {
      sealCredentialFiles(directory);
      const value = await new Promise((resolve, reject) => {
        const child = execFile(tool.executable, [...tool.args ?? [], ...args], { cwd: directory, env: this.environment(service, directory), timeout: 10_000, killSignal: "SIGKILL", maxBuffer, windowsHide: true }, (error, stdout) => {
          this.children.delete(child);
          try {
            const value = JSON.parse(stdout);
            // gh exits 1 for a GraphQL error response. Keep its structured envelope
            // so callers can distinguish permission refusal from lost transport;
            // native stderr and unstructured failures remain private.
            if (error && !(error.code === 1 && service === "github" && args[0] === "api" && args[1] === "graphql" && value && Array.isArray(value.errors) && "data" in value)) { reject(error); return; }
            resolve(value);
          } catch (parseError) { reject(error ?? parseError); }
        }); this.children.add(child);
      }); sealCredentialFiles(directory); return value;
    } catch { throw new FactoryError("account_login_unavailable", "The selected account could not be verified; finish its native sign-in and try again", 409); }
  }
  async codexAccount(directory: string): Promise<unknown> {
    const tool = this.tool("codex");
    sealCredentialFiles(directory);
    return new Promise((resolve, reject) => {
      const child = spawn(tool.executable, [...tool.args ?? [], "-c", 'cli_auth_credentials_store="file"', "app-server"], { cwd: directory, env: accountProcessEnvironment("codex", directory), stdio: "pipe", windowsHide: true });
      this.children.add(child); child.once("close", () => this.children.delete(child));
      let settled = false; let buffered = "";
      const finish = (value?: unknown, failed = false) => {
        if (settled) return; settled = true; clearTimeout(timer);
        try { sealCredentialFiles(directory); } catch { failed = true; }
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        const reap = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 2000); reap.unref(); child.once("close", () => clearTimeout(reap));
        if (failed) reject(new FactoryError("account_login_unavailable", "The selected Codex account could not be read without refreshing credentials", 409)); else resolve(value);
      };
      const timer = setTimeout(() => finish(undefined, true), 10_000);
      child.stdin.on("error", () => finish(undefined, true));
      child.on("error", () => finish(undefined, true)); child.on("close", () => finish(undefined, true));
      child.stderr.on("data", () => { /* Never retain native diagnostic/credential output. */ });
      child.stdout.on("data", (bytes: Buffer) => {
        buffered += bytes.toString("utf8"); if (buffered.length > 64 * 1024) { finish(undefined, true); return; }
        for (;;) {
          const end = buffered.indexOf("\n"); if (end < 0) break;
          const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
          try {
            const message = JSON.parse(line);
            if (message.id === 1 && message.result) child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n" + JSON.stringify({ id: 2, method: "account/read", params: { refreshToken: false } }) + "\n");
            if (message.id === 2) finish(message.result, Boolean(message.error));
          } catch { /* An unrelated native line is not an account receipt. */ }
        }
      });
      child.stdin.write(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "saurons-eye-account-check", version: "1" }, capabilities: {} } }) + "\n");
    });
  }
}
