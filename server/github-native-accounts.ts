import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AccountProfile, NativeAccountDiscovery } from "../shared/accounts.ts";
import { FactoryError, hash, inspectCheckout } from "./factory-host.ts";
import { githubDirectory } from "./project-discovery.ts";
import type { NativeAccountTools } from "./account-tools.ts";

const execute = promisify(execFile);
/** Selected-account credential access stays in the backend and never changes gh's active login. */
export class GithubNativeAccounts {
  constructor(private readonly native: NativeAccountTools, private readonly home = homedir()) {}
  private async context(path?: string) {
    const checkout = path ? (await inspectCheckout(path)).path : this.home;
    const route = await githubDirectory(checkout, this.home);
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: this.home, USERPROFILE: this.home, XDG_CONFIG_HOME: join(this.home, ".config"), GH_CONFIG_DIR: route.directory, GH_HOST: "github.com", GH_PROMPT_DISABLED: "1" };
    delete env.GH_TOKEN; delete env.GITHUB_TOKEN;
    return { checkout, route, env };
  }
  private async command(args: string[], path?: string) {
    const { checkout, route, env } = await this.context(path); const tool = this.native.tool("github");
    try { const result = await execute(tool.executable, [...tool.args ?? [], ...args], { cwd: checkout, env, timeout: 10000, maxBuffer: 128 * 1024, windowsHide: true }); return { stdout: result.stdout, route }; }
    catch { throw new FactoryError("native_accounts_unavailable", "The saved GitHub login could not be read; connect a Machine account instead", 409); }
  }
  async discover(profiles: AccountProfile[], path?: string): Promise<NativeAccountDiscovery> {
    try {
      const result = await this.command(["auth", "status", "--json", "hosts"], path);
      const rows = (JSON.parse(result.stdout) as { hosts?: Record<string, { login?: unknown; active?: boolean; state?: string }[]> }).hosts?.["github.com"] ?? [];
      return { protocol: 1, sources: rows.filter((row) => typeof row.login === "string" && /^[a-zA-Z0-9-]{1,100}$/.test(row.login)).map((row) => {
        const matching = profiles.filter((profile) => profile.service === "github" && profile.state !== "disabled" && profile.expected_login.toLowerCase() === String(row.login).toLowerCase());
        return { id: hash(result.route.directory + "\0" + row.login), service: "github", login: row.login as string, active: !!row.active, available: row.state === "success", existing_profile_id: matching.length === 1 ? matching[0]!.id : null };
      }), warnings: result.route.ambiguous ? ["Dynamic SSH routing needs explicit account selection"] : [] };
    } catch { return { protocol: 1, sources: [], warnings: ["Saved GitHub logins could not be read on this Machine"] }; }
  }
  async token(id: string, profiles: AccountProfile[], path?: string) {
    const discovered = await this.discover(profiles, path); const source = discovered.sources.find((entry) => entry.id === id);
    if (!source?.available) throw new FactoryError("native_account_changed", "Refresh and select an available saved GitHub login", 409);
    const { stdout } = await this.command(["auth", "token", "--hostname", "github.com", "--user", source.login], path); const token = stdout.trim();
    if (!/^[a-zA-Z0-9_]{20,256}$/.test(token)) throw new FactoryError("native_account_unavailable", "This native login cannot be imported; finish private account sign-in instead", 409);
    return { source, token };
  }
}
