import { withAccountEnvironment } from "./account-execution.ts";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import type { FactoryNative } from "./factory-native.ts";
import { FactoryError, git, inspectCheckout, withinRoot } from "./factory-host.ts";
import { AGENT_PERMISSION_MODES } from "../shared/agent-permissions.ts";
import type { FactoryProvider } from "../shared/factory.ts";
import type { ProjectDiscovery } from "../shared/project-setup.ts";

/** Read configuration only: never source .envrc, call credential helpers, or run SSH Match exec. */
export async function githubDirectory(path: string, home = homedir()) {
  const scopedGit = (args: string[]) => withAccountEnvironment(home === homedir() ? {} : { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config") }, () => git(path, args));
  const config = async (key: string) => { try { return (await scopedGit(["config", "--includes", "--get", key])).trim(); } catch { return ""; } };
  let origin = ""; try { origin = (await scopedGit(["remote", "get-url", "origin"])).trim(); } catch { /* A local repository needs no remote. */ }
  const remote = /^(?:https:\/\/|ssh:\/\/(?:git@)?|git@)([^/:]+)[:/]([^?#]+?)(?:\.git)?$/.exec(origin);
  let host = remote?.[1] ?? ""; let identityFile: string | null = null; let ambiguous = false;
  const expand = (value: string) => value.replace(/^~(?=\/|$)|^\$HOME(?=\/|$)|^\$\{HOME\}(?=\/|$)/, home);
  const ssh = join(home, ".ssh", "config");
  if (host && host !== "github.com" && existsSync(ssh)) {
    const info = lstatSync(ssh);
    if (info.isFile() && !info.isSymbolicLink() && info.size <= 256 * 1024) {
      let applies = false; let hostname: string | null = null;
      for (const raw of readFileSync(ssh, "utf8").split("\n")) {
        const [key, ...parts] = raw.trim().split(/\s+/); if (!key || key.startsWith("#")) continue;
        const value = parts.join(" ").replace(/^['"]|['"]$/g, "");
        if (key.toLowerCase() === "host") applies = parts.some((name) => name === host || name === "*");
        else if (key.toLowerCase() === "match" || key.toLowerCase() === "include") { ambiguous = true; applies = false; }
        else if (applies && key.toLowerCase() === "hostname" && !hostname) hostname = value;
        else if (applies && key.toLowerCase() === "identityfile" && !identityFile && !value.includes("%")) identityFile = resolve(home, expand(value));
      }
      if (hostname) host = hostname;
    }
  }
  const hint = await config("credential.https://github.com.username") || await config("credential.username") || null;
  const configured = await config("saurons.ghConfigDir");
  let ghDirectory = configured ? resolve(path, expand(configured)) : null;
  const envrc = join(path, ".envrc");
  if (!ghDirectory && existsSync(envrc) && lstatSync(envrc).isFile() && !lstatSync(envrc).isSymbolicLink() && lstatSync(envrc).size <= 64 * 1024) {
    const value = /^\s*(?:export\s+)?GH_CONFIG_DIR\s*=\s*(?:"([^"\n]+)"|'([^'\n]+)'|([^\s#]+))\s*(?:#.*)?$/m.exec(readFileSync(envrc, "utf8"));
    const literal = value?.[1] ?? value?.[2] ?? value?.[3];
    if (literal && !/[`();]|\$\(/.test(literal) && !/\$(?!HOME(?:\/|$)|\{HOME\})/.test(literal)) ghDirectory = resolve(path, expand(literal));
  }
  if (!ghDirectory) ghDirectory = home === homedir() && process.env["GH_CONFIG_DIR"] ? resolve(process.env["GH_CONFIG_DIR"]!) : join(home, ".config", "gh");
  return { repository: ["github.com", "ssh.github.com"].includes(host) && remote && /^[\w.-]+\/[\w.-]+$/.test(remote[2]!) ? remote[2]! : null, account_hint: hint, directory_scoped: !!configured || !!(ghDirectory !== join(home, ".config", "gh")), directory: ghDirectory, identity_file: identityFile, ambiguous };
}

export async function discoverProject(path: string, native: Pick<FactoryNative, "version">, home?: string): Promise<ProjectDiscovery> {
  if (!isAbsolute(path) || path.includes("\0")) throw new FactoryError("invalid_checkout", "Choose a repository folder");
  const inspected = await inspectCheckout(path); const root = inspected.path;
  const present = (name: string) => {
    const file = join(root, name); if (!existsSync(file)) return false;
    const info = lstatSync(file);
    return info.isFile() && !info.isSymbolicLink() && withinRoot(root, realpathSync(file));
  };
  const read = (name: string) => {
    const file = join(root, name); if (!existsSync(file)) return null;
    const info = lstatSync(file); if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024 || !withinRoot(root, realpathSync(file))) return null;
    return readFileSync(file, "utf8");
  };
  const checks: ProjectDiscovery["checks"] = []; const warnings: string[] = [];
  try {
    const pkg = JSON.parse(read("package.json") ?? "null");
    if (pkg && typeof pkg.scripts === "object" && pkg.scripts) {
      const manager = present("bun.lock") || present("bun.lockb") ? "bun" : present("pnpm-lock.yaml") ? "pnpm" : present("yarn.lock") ? "yarn" : "npm";
      const names = ["typecheck", "lint", pkg.scripts["test:unit"] ? "test:unit" : "test", "build"];
      for (const name of names) if (typeof pkg.scripts[name] === "string") checks.push({ id: `script:${name}`, name, args: [manager, "run", name] });
    }
  } catch { warnings.push("Project package metadata could not be read"); }
  const providers = await Promise.all((["codex", "claude", "opencode"] as FactoryProvider[]).map(async (provider) => { const version = await native.version(provider).catch(() => null); return { provider, installed: !!version, version }; }));
  const modes = Object.fromEntries(Object.entries(AGENT_PERMISSION_MODES).map(([p, values]) => [p, [...values]])) as ProjectDiscovery["permission_modes"];
  const version = providers.find((p) => p.provider === "codex")?.version?.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!version || Number(version[1]) === 0 && Number(version[2]) < 162) modes.codex = modes.codex.filter((mode) => mode !== "approve_for_me");
  const route = await githubDirectory(root, home);
  if (route.ambiguous) warnings.push("Dynamic SSH routing needs explicit account selection");
  return { protocol: 1, path: root, name: basename(root), repository: inspected.repository, head: inspected.head, checks, guidance: ["AGENTS.md", "CLAUDE.md", "CONTRIBUTING.md", "GLOSSARY.md", "GLOSSARY-MAP.md", "DESIGN.md"].filter((name) => read(name) !== null), providers, permission_modes: modes, github: { repository: route.repository, account_hint: route.account_hint, directory_scoped: route.directory_scoped }, warnings };
}
