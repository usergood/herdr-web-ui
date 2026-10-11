import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { AccountService } from "../shared/accounts.ts";
import { FactoryError } from "./factory-host.ts";

export interface AccountTool { executable: string; args?: string[] }
export type AccountTools = Partial<Record<AccountService, AccountTool>>;
const execute = promisify(execFile);

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
  readonly genuine: boolean;
  constructor(private readonly tools: AccountTools = {}) { this.genuine = Object.keys(tools).length === 0; }
  tool(service: AccountService): AccountTool {
    const executable = this.tools[service] ?? (() => { const path = Bun.which(service === "github" ? "gh" : service); return path ? { executable: path } : undefined; })();
    if (!executable) throw new FactoryError("account_tool_missing", "Install the selected native CLI on this Machine before setting up its account", 409);
    return executable;
  }
  async json(service: AccountService, args: string[], directory: string): Promise<unknown> {
    const tool = this.tool(service);
    try {
      const result = await execute(tool.executable, [...tool.args ?? [], ...args], { cwd: directory, env: accountProcessEnvironment(service, directory), timeout: 10_000, maxBuffer: 64 * 1024, windowsHide: true });
      return JSON.parse(result.stdout);
    } catch { throw new FactoryError("account_login_unavailable", "The selected account could not be verified; finish its native sign-in and try again", 409); }
  }
  async codexAccount(directory: string): Promise<unknown> {
    const tool = this.tool("codex");
    return new Promise((resolve, reject) => {
      const child = spawn(tool.executable, [...tool.args ?? [], "-c", 'cli_auth_credentials_store="file"', "app-server"], { cwd: directory, env: accountProcessEnvironment("codex", directory), stdio: "pipe", windowsHide: true });
      let settled = false; let buffered = "";
      const finish = (value?: unknown, failed = false) => {
        if (settled) return; settled = true; clearTimeout(timer);
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
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
