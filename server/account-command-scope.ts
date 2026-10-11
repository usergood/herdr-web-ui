import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { AccountService } from "../shared/accounts.ts";
import { FactoryError } from "./factory-host.ts";

/** Native project files must not override a selected Cloudflare login or account. */
export function checkCloudflareScope(service: AccountService, accountId: string, args: string[], cwd: string): void {
  if (service !== "cf" && service !== "wrangler") return;
  let directory = cwd; let config: string | undefined;
  const flag = args.findIndex((arg) => arg === "--config" || arg === "-c" || arg.startsWith("--config="));
  if (flag >= 0) { const selected = args[flag]!.startsWith("--config=") ? args[flag]!.slice(9) : args[flag + 1]; if (!selected) throw new FactoryError("account_scope_invalid", "Choose a valid scoped configuration", 409); config = isAbsolute(selected) ? selected : resolve(cwd, selected); }
  for (let depth = 0; depth < 32; depth++) {
    for (const name of readdirSync(directory).filter((name) => /^\.(?:env|dev\.vars)(?:\.|$)/.test(name))) {
      const file = join(directory, name); const info = statSync(file);
      if (!info.isFile() || info.size > 128 * 1024) throw new FactoryError("account_scope_invalid", "Project credential files exceed the scoped check budget", 409);
      const text = readFileSync(file, "utf8");
      if (/^\s*(?:export\s+)?(?:CLOUDFLARE_(?:API_TOKEN|API_KEY|EMAIL)|CF_(?:API_TOKEN|API_KEY|EMAIL))\s*=/m.test(text)) throw new FactoryError("account_override_forbidden", "Remove project-file Cloudflare credentials before using a bound profile", 409);
      for (const match of text.matchAll(/^\s*(?:export\s+)?CLOUDFLARE_ACCOUNT_ID\s*=\s*["']?([^\s"'\r\n]+)/gm)) if (match[1] !== accountId) throw new FactoryError("account_scope_mismatch", "Project configuration targets another Cloudflare account", 409);
    }
    if (!config && service === "wrangler") config = ["wrangler.json", "wrangler.jsonc", "wrangler.toml"].map((name) => join(directory, name)).find(existsSync);
    const parent = dirname(directory); if (parent === directory) break; directory = parent;
  }
  if (config) {
    const info = statSync(config); if (!info.isFile() || info.size > 128 * 1024) throw new FactoryError("account_scope_invalid", "Choose a bounded Wrangler configuration", 409);
    const text = readFileSync(config, "utf8");
    // Include environment sections: a bound invocation cannot switch resource account through --env.
    for (const match of text.matchAll(/["']?account_id["']?\s*[:=]\s*["']([^"']+)["']/g)) if (match[1] !== accountId) throw new FactoryError("account_scope_mismatch", "Wrangler configuration targets another Cloudflare account", 409);
  }
}
