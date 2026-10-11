import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { FactoryError } from "./factory-host.ts";

export const claudeSubscriptionSettings = JSON.stringify({ forceLoginMethod: "claudeai", apiKeyHelper: "", env: { ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "", ANTHROPIC_BASE_URL: "", ANTHROPIC_PROFILE: "", ANTHROPIC_FEDERATION_RULE_ID: "", ANTHROPIC_ORGANIZATION_ID: "", CLAUDE_CODE_OAUTH_TOKEN: "", CLAUDE_CODE_USE_BEDROCK: "", CLAUDE_CODE_USE_VERTEX: "", CLAUDE_CODE_USE_FOUNDRY: "" } });

/** Keep supported project settings while excluding credentials that outrank subscription OAuth. */
export function checkClaudeSubscription(profileDirectory: string, cwd?: string, args: string[] = []): void {
  function inspect(value: unknown): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new FactoryError("account_subscription_settings", "Use a valid subscription-only Claude settings object", 409);
    const settings = value as Record<string, unknown>;
    if (settings.apiKeyHelper || settings.forceLoginMethod && settings.forceLoginMethod !== "claudeai" || settings.forceLoginGatewayUrl) throw new FactoryError("account_subscription_settings", "Remove API, cloud or gateway authentication settings before using a subscription profile", 409);
    if (settings.env && typeof settings.env === "object" && Object.entries(settings.env).some(([key, val]) => /^(?:ANTHROPIC_(?:API_KEY|AUTH_TOKEN|BASE_URL|PROFILE|FEDERATION_RULE_ID|ORGANIZATION_ID)|CLAUDE_CODE_(?:OAUTH_TOKEN|USE_BEDROCK|USE_VERTEX|USE_FOUNDRY))$/.test(key) && Boolean(val))) throw new FactoryError("account_subscription_settings", "Remove conflicting Claude credential/provider environment settings", 409);
  }
  function file(path: string): void { if (!existsSync(path)) return; try { if (statSync(path).size > 128 * 1024) throw new Error(); inspect(JSON.parse(readFileSync(path, "utf8"))); } catch (error) { throw error instanceof FactoryError ? error : new FactoryError("account_subscription_settings", "Claude settings cannot be checked for subscription authentication", 409); } }
  for (const name of ["settings.json", "settings.local.json"]) file(join(profileDirectory, name));
  if (cwd) {
    let directory = cwd;
    for (let depth = 0; depth < 32; depth++) { for (const name of ["settings.json", "settings.local.json"]) file(join(directory, ".claude", name)); const parent = dirname(directory); if (parent === directory) break; directory = parent; }
    let common: string | undefined;
    try { common = execFileSync("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8", timeout: 5000, maxBuffer: 16_384, stdio: ["ignore", "pipe", "ignore"], env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))) }).trim(); } catch { /* A standalone invocation may have no Git repository. */ }
    if (common) for (const name of ["settings.json", "settings.local.json"]) file(join(dirname(common), ".claude", name));
  }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!; if (arg !== "--settings" && !arg.startsWith("--settings=")) continue;
    const value = arg.startsWith("--settings=") ? arg.slice(11) : args[++index];
    if (!value) throw new FactoryError("account_subscription_settings", "Select valid Claude subscription settings", 409);
    if (value.trim().startsWith("{")) { try { inspect(JSON.parse(value)); } catch (error) { throw error instanceof FactoryError ? error : new FactoryError("account_subscription_settings", "Select valid Claude subscription settings", 409); } }
    else file(join(cwd ?? process.cwd(), value));
  }
}
