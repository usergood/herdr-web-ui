import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AccountBindingSnapshot, AccountIdentity, AccountOverview, AccountProfile, AccountService, AccountSetup, ProjectAccountBindings } from "../shared/accounts.ts";
import { FactoryError, hash } from "./factory-host.ts";
import { NativeAccountTools, type AccountTools } from "./account-tools.ts";
import { AccountSetups, setupLease } from "./account-setup.ts";
import { accountRedactor } from "./account-privacy.ts";
import { checkCloudflareScope } from "./account-command-scope.ts";
import { checkClaudeSubscription, claudeSubscriptionSettings } from "./account-subscriptions.ts";
import { writePrivateFile } from "./factory-files.ts";

const services: AccountService[] = ["github", "codex", "claude", "cf", "wrangler"];
const execute = promisify(execFile);
interface PrivateProfile { profile: AccountProfile; directory: string }
interface Registry { host_id: string; profiles: PrivateProfile[] }

/** One Machine's private native account state, separate from factory records and backups. */
export class MachineAccounts {
  readonly root: string;
  private readonly file: string;
  private registry: Registry;
  private readonly operations = new Map<string, Promise<AccountProfile>>();
  private inUse: (id: string) => boolean = () => false;
  private stopped = false;
  readonly native: NativeAccountTools;
  private readonly setups: AccountSetups;
  constructor(stateDir: string, tools: AccountTools = {}, private readonly readOnly = false) {
    this.native = new NativeAccountTools(tools);
    this.root = join(stateDir, "accounts");
    if (readOnly && !existsSync(join(this.root, "registry.json"))) throw new FactoryError("account_state_invalid", "The frozen Machine account state is unavailable", 409);
    if (existsSync(this.root) && lstatSync(this.root).isSymbolicLink()) throw new FactoryError("account_state_invalid", "The Machine account directory is unavailable", 409);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    if (!readOnly) chmodSync(this.root, 0o700);
    this.file = join(this.root, "registry.json");
    if (existsSync(this.file)) {
      try {
        if (lstatSync(this.file).isSymbolicLink()) throw new Error("Invalid state");
        const saved = JSON.parse(readFileSync(this.file, "utf8")) as Registry;
        if (typeof saved.host_id !== "string" || !Array.isArray(saved.profiles) || saved.profiles.some((entry) => !entry.profile || typeof entry.profile.id !== "string" || entry.directory !== join(this.root, entry.profile.id))) throw new Error("Invalid state");
        this.registry = saved;
      } catch { throw new FactoryError("account_state_invalid", "Preserve the invalid Machine account state for recovery", 409); }
    } else {
      this.registry = { host_id: randomUUID(), profiles: [] };
      this.save(this.registry);
    }
    this.setups = new AccountSetups(this.native, (id, revision, current) => this.verify(id, { expected_revision: revision }, current), (id) => {
      if (this.stopped) return;
      const entry = this.entry(id);
      this.update(entry, { ...entry.profile, state: "needs_login", verified_identity: null, problem: "Sign-in stopped or was not verified; check the selected account before retrying", updated_at: new Date().toISOString() });
    });
  }
  overview(): AccountOverview { this.registry = this.readRegistry(); return { protocol: 1, host_id: this.registry.host_id, profiles: this.registry.profiles.map((entry) => structuredClone(entry.profile)) }; }
  sanitize<T>(value: T): T { return JSON.parse(accountRedactor(this.root)(JSON.stringify(value))) as T; }
  assertPublic(text: string): void { if (accountRedactor(this.root)(text) !== text) throw new FactoryError("account_private_material", "Private Machine account material cannot be retained in factory history or artifacts", 409); }
  usage(check: (id: string) => boolean): void { this.inUse = check; }
  private mutable(entry: PrivateProfile, body: Record<string, unknown>): void {
    if (entry.profile.revision !== body.expected_revision) throw new FactoryError("account_changed", "Refresh the account profile before continuing", 409);
    if (this.inUse(entry.profile.id)) throw new FactoryError("account_in_use", "Stop or finish the Runs using this account before changing its setup", 409);
    if (this.operations.has(entry.profile.id) || existsSync(setupLease(join(entry.directory, entry.profile.service)))) throw new FactoryError("account_setup_busy", "Finish or recover this account operation first", 409);
  }
  configure(id: string, body: Record<string, unknown>): AccountProfile {
    const entry = this.entry(id); this.mutable(entry, body);
    const name = body.name ?? entry.profile.name; const login = body.expected_login ?? entry.profile.expected_login;
    const accountId = body.expected_account_id === undefined ? entry.profile.expected_account_id : body.expected_account_id;
    if (typeof name !== "string" || !name.trim() || name.length > 100 || /[\r\n\0]/.test(name) || typeof login !== "string" || !login.trim() || login.length > 200 || /[\r\n\0]/.test(login) || accountId !== null && (typeof accountId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(accountId))) throw new FactoryError("invalid_account_profile", "Enter the expected profile name and identity");
    if ((entry.profile.service === "cf" || entry.profile.service === "wrangler") && (typeof accountId !== "string" || !/^[a-fA-F0-9]{32}$/.test(accountId))) throw new FactoryError("account_scope_required", "Choose the Cloudflare account identifier explicitly");
    if (entry.profile.github_key_id && (login.trim().toLowerCase() !== entry.profile.expected_login.toLowerCase() || accountId !== entry.profile.expected_account_id)) throw new FactoryError("account_key_identity_locked", "Create another profile for another GitHub identity; this registered key belongs to its existing account", 409);
    return this.update(entry, { ...entry.profile, revision: randomUUID(), name: name.trim(), expected_login: login.trim(), expected_account_id: accountId, state: "needs_login", verified_identity: null, problem: null, updated_at: new Date().toISOString() });
  }
  disable(id: string, body: Record<string, unknown>): AccountProfile {
    const entry = this.entry(id); this.mutable(entry, body);
    return this.update(entry, { ...entry.profile, revision: randomUUID(), state: "disabled", verified_identity: null, updated_at: new Date().toISOString() });
  }
  async freeze(bindings: ProjectAccountBindings): Promise<AccountBindingSnapshot> {
    if (!bindings || typeof bindings !== "object" || Array.isArray(bindings) || Object.entries(bindings).some(([service, id]) => !services.includes(service as AccountService) || typeof id !== "string")) throw new FactoryError("invalid_account_bindings", "Select registered service profiles on this Machine");
    const profiles: AccountBindingSnapshot["profiles"] = [];
    for (const service of services) {
      const id = bindings[service]; if (!id) continue;
      const entry = this.entry(id);
      if (entry.profile.service !== service || entry.profile.state !== "ready") throw new FactoryError("account_not_ready", "Verify this service profile before binding it to a Project", 409);
      const verified = await this.verify(id, { expected_revision: entry.profile.revision });
      if (!verified.verified_identity) throw new FactoryError("account_not_ready", "The selected identity is unavailable", 409);
      profiles.push({ id, revision: verified.revision, service, identity: verified.verified_identity });
    }
    return { host_id: this.registry.host_id, profiles };
  }
  async environment(snapshot: AccountBindingSnapshot | null | undefined, launchers = false, cwd?: string): Promise<Record<string, string>> {
    if (!snapshot) return {};
    if (snapshot.host_id !== this.registry.host_id || !Array.isArray(snapshot.profiles)) throw new FactoryError("account_host_changed", "The frozen account scope belongs to another Machine", 409);
    const environment: Record<string, string> = {};
    for (const reference of snapshot.profiles) {
      const entry = this.entry(reference.id);
      if (entry.profile.revision !== reference.revision || entry.profile.service !== reference.service || entry.profile.state !== "ready") throw new FactoryError("account_changed", "A frozen account profile changed or is unavailable; do not select a fallback", 409);
      const verified = await this.verify(reference.id, { expected_revision: reference.revision });
      if (JSON.stringify(verified.verified_identity) !== JSON.stringify(reference.identity)) throw new FactoryError("account_identity_mismatch", "The frozen native identity changed", 409);
      const directory = join(entry.directory, reference.service);
      if (reference.service === "claude") checkClaudeSubscription(directory, cwd);
      if (reference.service === "github") Object.assign(environment, { GH_CONFIG_DIR: directory, GH_HOST: "github.com", GH_TOKEN: "", GITHUB_TOKEN: "", GH_ENTERPRISE_TOKEN: "", GITHUB_ENTERPRISE_TOKEN: "" });
      if (reference.service === "codex") Object.assign(environment, { CODEX_HOME: directory, CODEX_API_KEY: "", CODEX_ACCESS_TOKEN: "", OPENAI_API_KEY: "", OPENAI_BASE_URL: "" });
      if (reference.service === "claude") Object.assign(environment, { CLAUDE_CONFIG_DIR: directory, ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "", ANTHROPIC_BASE_URL: "", CLAUDE_CODE_OAUTH_TOKEN: "", CLAUDE_CODE_USE_BEDROCK: "", CLAUDE_CODE_USE_VERTEX: "", CLAUDE_CODE_USE_FOUNDRY: "" });
      if (reference.service === "cf" || reference.service === "wrangler") Object.assign(environment, { CLOUDFLARE_API_TOKEN: "", CLOUDFLARE_API_KEY: "", CLOUDFLARE_EMAIL: "", CLOUDFLARE_ACCOUNT_ID: reference.identity.account_id ?? "" });
    }
    if (launchers && snapshot.profiles.length) {
      const tools = Object.fromEntries(snapshot.profiles.map((profile) => [profile.service, this.native.tool(profile.service)]));
      const directory = join(this.root, "launchers", hash(JSON.stringify({ snapshot, tools })).slice(0, 24));
      const bin = join(directory, "bin"); mkdirSync(bin, { recursive: true, mode: 0o700 });
      const scope = join(directory, "scope.json");
      if (!existsSync(scope)) writePrivateFile(scope, JSON.stringify({ state_dir: join(this.root, ".."), snapshot, tools }));
      const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
      const entry = join(import.meta.dir, "account-command.ts");
      for (const reference of snapshot.profiles) {
        const command = reference.service === "github" ? "gh" : reference.service;
        const wrapper = join(bin, command + (process.platform === "win32" ? ".cmd" : ""));
        if (!existsSync(wrapper)) {
          const script = process.platform === "win32" ? `@echo off\r\n"${process.execPath.replaceAll("%", "%%")}" "${entry.replaceAll("%", "%%")}" "${scope.replaceAll("%", "%%")}" ${reference.service} %*\r\n` : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(entry)} ${quote(scope)} ${reference.service} "$@"\n`;
          writeFileSync(wrapper, script, { mode: 0o700, flag: "wx" });
        }
      }
      const github = snapshot.profiles.find((reference) => reference.service === "github");
      if (github) {
        environment["GIT_SSH_COMMAND"] = `${quote(process.execPath)} ${quote(join(import.meta.dir, "account-ssh.ts"))} ${quote(scope)}`;
        Object.assign(environment, { GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", GIT_CONFIG_COUNT: "3", GIT_CONFIG_KEY_0: "credential.helper", GIT_CONFIG_VALUE_0: "", GIT_CONFIG_KEY_1: "credential.https://github.com.helper", GIT_CONFIG_VALUE_1: `!${quote(process.execPath)} ${quote(entry)} ${quote(scope)} github auth git-credential`, GIT_CONFIG_KEY_2: "credential.interactive", GIT_CONFIG_VALUE_2: "false" });
      }
      environment["PATH"] = bin + (process.platform === "win32" ? ";" : ":") + (process.env["PATH"] ?? "");
    }
    return environment;
  }
  async command(snapshot: AccountBindingSnapshot, service: AccountService, args: string[]): Promise<number> {
    await this.environment(snapshot);
    const reference = snapshot.profiles.find((profile) => profile.service === service);
    if (!reference) throw new FactoryError("account_not_bound", "This service has no frozen account binding", 409);
    const credentialHelper = service === "github" && args[0] === "auth" && args[1] === "git-credential" && args.length <= 3 && [undefined, "get", "store", "erase"].includes(args[2]);
    if (args.some((arg) => ["auth", "login", "logout"].includes(arg)) && !credentialHelper || args[0] === "config") throw new FactoryError("account_mutation_forbidden", "Use the owner account controls to change native authentication", 409);
    if (args.some((arg) => /^--(?:profile|account-id|account|hostname|host)(?:=|$)/.test(arg))) throw new FactoryError("account_override_forbidden", "This command cannot override its frozen account selection", 409);
    const entry = this.entry(reference.id); const tool = this.native.tool(service);
    const env = this.native.environment(service, join(entry.directory, service));
    if (service === "claude") { checkClaudeSubscription(join(entry.directory, service), process.cwd(), args); args = [...args, "--settings", claudeSubscriptionSettings]; }
    if (service === "codex") {
      for (const arg of args) if (/(?:api_key|access_token|base_url|model_provider|forced_login_method|cli_auth_credentials_store)\s*=/.test(arg) && !['cli_auth_credentials_store="file"', 'forced_login_method="chatgpt"', 'model_provider="openai"'].includes(arg)) throw new FactoryError("account_override_forbidden", "Keep the selected subscription and native credential store", 409);
      args = ["-c", 'cli_auth_credentials_store="file"', "-c", 'forced_login_method="chatgpt"', "-c", 'model_provider="openai"', ...args];
    }
    if (service === "cf" || service === "wrangler") {
      checkCloudflareScope(service, reference.identity.account_id!, args, process.cwd());
      Object.assign(env, { CLOUDFLARE_API_TOKEN: "", CLOUDFLARE_API_KEY: "", CLOUDFLARE_EMAIL: "", CLOUDFLARE_ACCOUNT_ID: reference.identity.account_id ?? "" });
      if (service === "cf") args = [...args, "--profile", "saurons-" + reference.id];
    }
    const child = Bun.spawn([tool.executable, ...tool.args ?? [], ...args], { cwd: process.cwd(), env, stdin: "inherit", stdout: "inherit", stderr: "inherit", windowsHide: true });
    const forward = (signal: NodeJS.Signals) => { if (child.exitCode === null) child.kill(signal); };
    process.on("SIGTERM", forward); process.on("SIGINT", forward);
    try { return await child.exited; } finally { process.off("SIGTERM", forward); process.off("SIGINT", forward); }
  }
  async ssh(snapshot: AccountBindingSnapshot, args: string[]): Promise<number> {
    await this.environment(snapshot);
    const reference = snapshot.profiles.find((profile) => profile.service === "github");
    if (!reference || !this.entry(reference.id).profile.github_key_id) throw new FactoryError("account_key_required", "Register the selected GitHub key before using SSH", 409);
    const executable = Bun.which("ssh"); if (!executable) throw new FactoryError("account_tool_missing", "Install OpenSSH on this Machine", 409);
    if (args.some((arg, index) => arg.startsWith("-i") || arg.startsWith("-F") || arg.startsWith("-o") && /^(IdentityFile|IdentityAgent|IdentitiesOnly|CertificateFile|StrictHostKeyChecking|UserKnownHostsFile|GlobalKnownHostsFile|KnownHostsCommand|HostKeyAlias|HostKeyAlgorithms)\s*(?:=|\s)/i.test(arg === "-o" ? args[index + 1] ?? "" : arg.slice(2)))) throw new FactoryError("account_override_forbidden", "The SSH command cannot override the selected account key or host verification", 409);
    const resolved = await execute(executable, ["-G", ...args], { timeout: 5000, maxBuffer: 64 * 1024, windowsHide: true });
    const options = new Map(resolved.stdout.split("\n").map((line) => { const offset = line.indexOf(" "); return [line.slice(0, offset), line.slice(offset + 1)] as const; }));
    const hostname = options.get("hostname"); const port = options.get("port");
    if (!["github.com", "ssh.github.com"].includes(hostname ?? "") || options.get("user") !== "git" || !/^\d+$/.test(port ?? "")) throw new FactoryError("account_host_mismatch", "The selected GitHub account cannot authenticate to this SSH destination", 409);
    const own = ["-F", "none", "-o", "HostName=" + hostname, "-l", "git", "-p", port!, "-i", join(this.entry(reference.id).directory, "id_ed25519"), "-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none"];
    for (const key of ["proxycommand", "proxyjump"] as const) { const value = options.get(key); if (value && value !== "none") own.push("-o", `${key}=${value}`); }
    const child = Bun.spawn([executable, ...own, ...args], { stdin: "inherit", stdout: "inherit", stderr: "inherit", windowsHide: true });
    const forward = (signal: NodeJS.Signals) => { if (child.exitCode === null) child.kill(signal); };
    process.on("SIGTERM", forward); process.on("SIGINT", forward);
    try { return await child.exited; } finally { process.off("SIGTERM", forward); process.off("SIGINT", forward); }
  }
  create(body: Record<string, unknown>): AccountProfile {
    this.registry = this.readRegistry();
    if (typeof body.name !== "string" || !body.name.trim() || body.name.length > 100 || !services.includes(body.service as AccountService) || typeof body.expected_login !== "string" || !body.expected_login.trim() || body.expected_login.length > 200 || /[\r\n\0]/.test(body.expected_login)) throw new FactoryError("invalid_account_profile", "Enter a name, supported service and expected login");
    const expectedAccountId = body.expected_account_id === undefined || body.expected_account_id === null ? null : body.expected_account_id;
    if (expectedAccountId !== null && (typeof expectedAccountId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(expectedAccountId))) throw new FactoryError("invalid_account_profile", "Enter a valid expected account identifier");
    if ((body.service === "cf" || body.service === "wrangler") && (typeof expectedAccountId !== "string" || !/^[a-fA-F0-9]{32}$/.test(expectedAccountId))) throw new FactoryError("account_scope_required", "Choose the Cloudflare account identifier explicitly");
    const id = randomUUID(); const now = new Date().toISOString();
    const profile: AccountProfile = { id, revision: randomUUID(), name: body.name.trim(), service: body.service as AccountService, expected_login: body.expected_login.trim(), expected_account_id: expectedAccountId, state: "needs_login", verified_identity: null, public_key: null, fingerprint: null, problem: null, created_at: now, updated_at: now };
    const directory = join(this.root, id);
    mkdirSync(directory, { mode: 0o700 });
    mkdirSync(join(directory, profile.service), { mode: 0o700 });
    this.save({ ...this.registry, profiles: [...this.registry.profiles, { profile, directory }] });
    return structuredClone(profile);
  }
  private entry(id: string): PrivateProfile {
    this.registry = this.readRegistry();
    const entry = this.registry.profiles.find((record) => record.profile.id === id);
    if (!entry) throw new FactoryError("account_not_found", "Account profile not found", 404);
    return entry;
  }
  private update(entry: PrivateProfile, profile: AccountProfile): AccountProfile {
    if (this.stopped) return structuredClone(profile);
    if (this.entry(profile.id).profile.revision !== entry.profile.revision) throw new FactoryError("account_changed", "The account changed during this operation; refresh before continuing", 409);
    if (this.stopped || this.readOnly) return structuredClone(profile);
    this.save({ ...this.registry, profiles: this.registry.profiles.map((record) => record.profile.id === profile.id ? { ...entry, profile } : record) });
    return structuredClone(profile);
  }
  async setup(id: string, body: Record<string, unknown>): Promise<AccountSetup> {
    const entry = this.entry(id);
    if (entry.profile.revision !== body.expected_revision || entry.profile.state === "disabled") throw new FactoryError("account_changed", "Refresh the enabled account profile before signing in", 409);
    if (this.inUse(id)) throw new FactoryError("account_in_use", "Stop or finish the Runs using this account before signing in again", 409);
    if (this.operations.has(id)) throw new FactoryError("account_setup_busy", "Finish the current account operation first", 409);
    const result = await this.setups.start(entry.profile, join(entry.directory, entry.profile.service));
    this.update(entry, { ...entry.profile, state: "setting_up", verified_identity: null, problem: null, updated_at: new Date().toISOString() });
    return result;
  }
  async setupOperation(id: string, operation: string, body: Record<string, unknown>): Promise<AccountSetup> {
    if (typeof body.session_id !== "string") throw new FactoryError("invalid_account_setup", "Select the native sign-in session");
    this.setups.status(body.session_id, id);
    return operation === "status" ? this.setups.status(body.session_id, id) : operation === "input" ? this.setups.input(body.session_id, id, body.input) : this.setups.cancel(body.session_id);
  }
  async operation(id: string, operation: string, body: Record<string, unknown>): Promise<AccountProfile | AccountSetup> {
    if (operation === "recover") { const entry = this.entry(id); if (this.inUse(id)) throw new FactoryError("account_in_use", "Finish the Runs using this account first", 409); this.setups.recover(join(entry.directory, entry.profile.service)); return this.update(entry, { ...entry.profile, state: "needs_login", verified_identity: null, problem: null }); }
    if (operation === "key") return this.key(id, body);
    if (operation === "verify") return this.verify(id, body);
    if (operation === "register-key") return this.registerKey(id, body);
    if (operation === "configure") return this.configure(id, body);
    if (operation === "disable") return this.disable(id, body);
    if (operation === "setup") return this.setup(id, body);
    if (["setup/status", "setup/input", "setup/cancel"].includes(operation)) return this.setupOperation(id, operation.slice("setup/".length), body);
    throw new FactoryError("not_found", "Unknown account operation", 404);
  }
  stop(): void { this.setups.stop(); this.stopped = true; this.native.stop(); }
  async verify(id: string, body: Record<string, unknown>, current?: () => boolean): Promise<AccountProfile> {
    const entry = this.entry(id);
    if (!current && existsSync(setupLease(join(entry.directory, entry.profile.service)))) throw new FactoryError("account_setup_busy", "Finish or recover the native sign-in before verification", 409);
    if (entry.profile.revision !== body.expected_revision || entry.profile.state === "disabled") throw new FactoryError("account_changed", "Refresh the enabled account profile before continuing", 409);
    let identity: AccountIdentity;
    try {
    if (entry.profile.service === "github") {
      const result = await this.native.json("github", ["api", "user"], join(entry.directory, "github")) as { login?: unknown; id?: unknown };
      if (typeof result?.login !== "string" || !/^[a-zA-Z0-9-]{1,100}$/.test(result.login)) throw new FactoryError("account_identity_unavailable", "The native CLI did not identify the selected login", 409);
      identity = { login: result.login, account_id: typeof result.id === "number" || typeof result.id === "string" ? String(result.id) : null, auth_method: "oauth" };
    } else if (entry.profile.service === "codex") {
      const result = await this.native.codexAccount(join(entry.directory, "codex")) as { account?: { type?: unknown; email?: unknown } };
      if (result?.account?.type !== "chatgpt") throw new FactoryError("account_subscription_required", "Sign in with the selected ChatGPT subscription; API-key billing is not accepted", 409);
      if (typeof result.account.email !== "string" || result.account.email.length > 200) throw new FactoryError("account_identity_unavailable", "The native CLI did not identify the selected subscription login", 409);
      identity = { login: result.account.email, account_id: null, auth_method: "subscription" };
    } else if (entry.profile.service === "claude") {
      const directory = join(entry.directory, "claude");
      const result = await this.native.json("claude", ["auth", "status"], directory) as { loggedIn?: unknown; authMethod?: unknown; email?: unknown; configDirectory?: unknown };
      checkClaudeSubscription(directory);
      if (result?.loggedIn !== true || result.authMethod !== "claude.ai") throw new FactoryError("account_subscription_required", "Sign in with the selected Claude subscription; API keys and third-party billing are not accepted", 409);
      if (typeof result.configDirectory !== "string" || realpathSync(result.configDirectory) !== realpathSync(directory)) throw new FactoryError("account_storage_unverified", "Update Claude Code to a version that confirms the selected configuration directory", 409);
      if (typeof result.email !== "string" || result.email.length > 200) throw new FactoryError("account_identity_unavailable", "The native CLI did not identify the selected subscription login", 409);
      identity = { login: result.email, account_id: null, auth_method: "subscription" };
    } else if (entry.profile.service === "cf" || entry.profile.service === "wrangler") {
      const service = entry.profile.service;
      const args = service === "cf" ? ["auth", "whoami", "--profile", "saurons-" + id] : ["whoami", "--json"];
      const result = await this.native.json(service, args, join(entry.directory, service)) as { authenticated?: unknown; tokenValid?: unknown; email?: unknown; accounts?: { id?: unknown }[] };
      if (typeof result?.email !== "string" || result.email.length > 200 || result.authenticated === false || result.tokenValid === false || !Array.isArray(result.accounts)) throw new FactoryError("account_identity_unavailable", "The native CLI did not verify the Cloudflare login and membership", 409);
      if (!result.accounts.some((account) => account.id === entry.profile.expected_account_id)) throw new FactoryError("account_scope_mismatch", "The selected profile cannot reach the expected Cloudflare account", 409);
      identity = { login: result.email, account_id: entry.profile.expected_account_id, auth_method: "oauth" };
    } else throw new FactoryError("account_setup_required", "Finish setup for this native service before verification", 409);
    } catch (error) {
      if (current && !current()) throw new FactoryError("account_setup_cancelled", "The account sign-in stopped", 409);
      this.update(entry, { ...entry.profile, state: "needs_login", verified_identity: null, problem: "The selected native login is unavailable; sign in and verify it again", updated_at: new Date().toISOString() });
      throw error instanceof FactoryError ? error : new FactoryError("account_login_unavailable", "The selected native login could not be verified", 409);
    }
    if (current && !current()) throw new FactoryError("account_setup_cancelled", "The account sign-in stopped", 409);
    if (identity.login.toLowerCase() !== entry.profile.expected_login.toLowerCase() || entry.profile.expected_account_id !== null && identity.account_id !== entry.profile.expected_account_id) {
      this.update(entry, { ...entry.profile, state: "needs_login", verified_identity: null, problem: "The native login does not match the expected account", updated_at: new Date().toISOString() });
      throw new FactoryError("account_identity_mismatch", "The native login does not match the expected account; no fallback was selected", 409);
    }
    return this.update(entry, { ...entry.profile, state: "ready", verified_identity: identity, problem: null, updated_at: new Date().toISOString() });
  }
  async registerKey(id: string, body: Record<string, unknown>): Promise<AccountProfile> {
    this.mutable(this.entry(id), body);
    const operation = this.registerNativeKey(id, body); this.operations.set(id, operation);
    try { return await operation; } finally { if (this.operations.get(id) === operation) this.operations.delete(id); }
  }
  private async registerNativeKey(id: string, body: Record<string, unknown>): Promise<AccountProfile> {
    await this.verify(id, body);
    const entry = this.entry(id);
    if (entry.profile.service !== "github" || !entry.profile.public_key) throw new FactoryError("account_key_required", "Generate this GitHub profile's managed key first", 409);
    if (entry.profile.github_key_id) return structuredClone(entry.profile);
    const directory = join(entry.directory, "github");
    const keyIdentity = (key: string) => key.trim().split(/\s+/).slice(0, 2).join(" ");
    const selectedKey = keyIdentity(entry.profile.public_key);
    const keys = await this.native.json("github", ["api", "user/keys", "--paginate", "--slurp"], directory) as unknown;
    const listed = Array.isArray(keys) ? keys.flat() as { id?: unknown; key?: unknown }[] : [];
    let result = listed.find((key) => typeof key.key === "string" && keyIdentity(key.key) === selectedKey);
    if (!result) result = await this.native.json("github", ["api", "user/keys", "--method", "POST", "-f", "title=Saurons eye " + entry.profile.name, "-f", "key=" + entry.profile.public_key], directory) as { id?: unknown; key?: unknown };
    if (typeof result?.id !== "number" || typeof result.key !== "string" || keyIdentity(result.key) !== selectedKey) throw new FactoryError("account_key_unconfirmed", "GitHub did not confirm this exact public key; inspect it before retrying", 409);
    return this.update(entry, { ...entry.profile, revision: randomUUID(), github_key_id: result.id, updated_at: new Date().toISOString() });
  }
  async key(id: string, body: Record<string, unknown>): Promise<AccountProfile> {
    const entry = this.entry(id);
    if (this.inUse(id) || existsSync(setupLease(join(entry.directory, entry.profile.service)))) throw new FactoryError("account_setup_busy", "Finish this account's active work before changing its key", 409);
    if (entry.profile.revision !== body.expected_revision) throw new FactoryError("account_changed", "Refresh the account profile before continuing", 409);
    if (entry.profile.service !== "github" || entry.profile.state === "disabled") throw new FactoryError("invalid_account_operation", "Select an enabled GitHub profile", 409);
    if (entry.profile.public_key) return structuredClone(entry.profile);
    const pending = this.operations.get(id);
    if (pending) return pending;
    const operation = this.generateKey(entry);
    this.operations.set(id, operation);
    try { return await operation; } finally { if (this.operations.get(id) === operation) this.operations.delete(id); }
  }
  private async generateKey(entry: PrivateProfile): Promise<AccountProfile> {
    const executable = Bun.which("ssh-keygen");
    if (!executable) throw new FactoryError("account_tool_missing", "Install OpenSSH key tools on this Machine before generating a key", 409);
    const destination = join(entry.directory, "id_ed25519");
    if (existsSync(destination) || existsSync(destination + ".pub")) throw new FactoryError("account_key_exists", "Preserve the existing key material and inspect this profile before continuing", 409);
    const temporary = join(entry.directory, ".key-" + randomUUID());
    try {
      await execute(executable, ["-q", "-t", "ed25519", "-N", "", "-C", `${entry.profile.id}@saurons-eye`, "-f", temporary], { timeout: 10_000, maxBuffer: 16_384, windowsHide: true });
      const publicKey = readFileSync(temporary + ".pub", "utf8").trim();
      const fingerprint = (await execute(executable, ["-l", "-E", "sha256", "-f", temporary + ".pub"], { timeout: 5000, maxBuffer: 16_384, windowsHide: true })).stdout.split(/\s+/)[1];
      if (!/^ssh-ed25519 [A-Za-z0-9+/=]+ [^\r\n]+$/.test(publicKey) || !fingerprint?.startsWith("SHA256:")) throw new Error("Invalid key result");
      chmodSync(temporary, 0o600); chmodSync(temporary + ".pub", 0o600);
      if (existsSync(destination) || existsSync(destination + ".pub")) throw new FactoryError("account_key_exists", "Key material changed during generation; preserve it for inspection", 409);
      renameSync(temporary, destination); renameSync(temporary + ".pub", destination + ".pub");
      return this.update(entry, { ...entry.profile, revision: randomUUID(), public_key: publicKey, fingerprint, updated_at: new Date().toISOString() });
    } catch (error) {
      if (error instanceof FactoryError) throw error;
      throw new FactoryError("account_key_failed", "The Machine could not create the managed key; no command output was retained", 409);
    } finally { rmSync(temporary, { force: true }); rmSync(temporary + ".pub", { force: true }); }
  }
  private save(registry: Registry): void {
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try { writeFileSync(temporary, JSON.stringify(registry) + "\n", { flag: "wx", mode: 0o600 }); renameSync(temporary, this.file); this.registry = registry; }
    finally { rmSync(temporary, { force: true }); }
  }
  private readRegistry(): Registry {
    try {
    if (lstatSync(this.file).isSymbolicLink()) throw new FactoryError("account_state_invalid", "The Machine account registry is unavailable", 409);
    const saved = JSON.parse(readFileSync(this.file, "utf8")) as Registry;
    if (typeof saved.host_id !== "string" || !Array.isArray(saved.profiles) || saved.profiles.some((entry) => !entry.profile || !/^[a-f0-9-]{36}$/.test(entry.profile.id) || entry.directory !== join(this.root, entry.profile.id) || !services.includes(entry.profile.service))) throw new FactoryError("account_state_invalid", "Preserve the invalid Machine account state for recovery", 409);
    const fields: (keyof AccountProfile)[] = ["id", "revision", "name", "service", "expected_login", "expected_account_id", "state", "verified_identity", "public_key", "fingerprint", "github_key_id", "problem", "created_at", "updated_at"];
    return { host_id: saved.host_id, profiles: saved.profiles.map((entry) => {
      const profile = Object.fromEntries(fields.filter((key) => key in entry.profile).map((key) => [key, entry.profile[key]])) as unknown as AccountProfile;
      if (typeof profile.revision !== "string" || !/^[a-f0-9-]{36}$/.test(profile.revision) || typeof profile.name !== "string" || typeof profile.expected_login !== "string" || !["needs_login", "ready", "disabled", "setting_up", "failed"].includes(profile.state) || profile.expected_account_id !== null && typeof profile.expected_account_id !== "string" || profile.public_key !== null && (typeof profile.public_key !== "string" || !/^ssh-ed25519 [A-Za-z0-9+/=]+ [^\r\n]+$/.test(profile.public_key))) throw new FactoryError("account_state_invalid", "Preserve the invalid Machine account state for recovery", 409);
      if (lstatSync(entry.directory).isSymbolicLink() || lstatSync(join(entry.directory, profile.service)).isSymbolicLink()) throw new FactoryError("account_state_invalid", "Preserve linked Machine account state for recovery", 409);
      if (profile.verified_identity) profile.verified_identity = { login: profile.verified_identity.login, account_id: profile.verified_identity.account_id, auth_method: profile.verified_identity.auth_method };
      return { directory: entry.directory, profile };
    }) };
    } catch (error) { throw error instanceof FactoryError ? error : new FactoryError("account_state_invalid", "Preserve the invalid Machine account state for recovery", 409); }
  }
}
