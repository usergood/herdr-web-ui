import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FactoryError } from "./factory-host.ts";
import { isAccountHistory } from "./account-history.ts";

/** Only profile-owned credential/config files are read. Native histories are not scanned. */
export function accountRedactor(root: string): (text: string) => string {
  const secrets = new Set<string>(); let count = 0; let bytes = 0;
  function collect(value: unknown, sensitive = false): void {
    if (typeof value === "string") { if (sensitive && value.length >= 8) secrets.add(value); }
    else if (Array.isArray(value)) for (const item of value) collect(item, sensitive);
    else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) collect(item, sensitive || /token|secret|password|api.?key|private.?key/i.test(key));
  }
  function visit(directory: string, depth: number): void {
    if (depth > 5) return;
    for (const name of readdirSync(directory)) {
      if (isAccountHistory(name)) continue;
      if (++count > 2000) throw new FactoryError("account_privacy_unavailable", "Account credential redaction needs operator recovery", 409);
      const file = join(directory, name); const stat = lstatSync(file);
      if (stat.isSymbolicLink()) throw new FactoryError("account_privacy_unavailable", "Preserve linked account state for operator recovery", 409);
      if (stat.isDirectory()) { visit(file, depth + 1); continue; }
      if (!stat.isFile() || !/auth|credential|hosts\.|config|token|secret|^id_ed25519$/i.test(name) || /\.pub$/.test(name)) continue;
      bytes += stat.size; if (stat.size > 1024 * 1024 || bytes > 4 * 1024 * 1024) throw new FactoryError("account_privacy_unavailable", "Account credential files exceed the redaction budget", 409);
      const text = readFileSync(file, "utf8");
      if (name === "id_ed25519") { secrets.add(text.trim()); for (const line of text.split(/\r?\n/)) if (line.length > 20 && !line.startsWith("---")) secrets.add(line); }
      try { collect(JSON.parse(text)); } catch { /* Native YAML/TOML credential storage. */ }
      for (const match of text.matchAll(/(?:token|secret|password|api.?key)\s*[=:]\s*["']?([^\s"'\r\n,}]+)/gi)) if (match[1] && match[1].length >= 8) secrets.add(match[1]);
    }
  }
  try { visit(root, 0); } catch (error) { throw error instanceof FactoryError ? error : new FactoryError("account_privacy_unavailable", "Account credentials cannot be checked before retaining evidence", 409); }
  const ordered = [...secrets].sort((a, b) => b.length - a.length);
  return (text) => {
    let safe = text.replaceAll(root, "[private Machine accounts]").replaceAll(root.replaceAll("\\", "\\\\"), "[private Machine accounts]");
    for (const secret of ordered) { safe = safe.replaceAll(secret, "[account credential redacted]").replaceAll(JSON.stringify(secret).slice(1, -1), "[account credential redacted]"); }
    return safe.replace(/(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|sk-proj-[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/g, "[account credential redacted]").replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[private key redacted]");
  };
}
