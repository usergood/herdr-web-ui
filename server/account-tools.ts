import { execFile } from "node:child_process";
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
}
