import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AccountIdentity, AccountOverview, AccountProfile, AccountService } from "../shared/accounts.ts";
import { FactoryError } from "./factory-host.ts";
import { NativeAccountTools, type AccountTools } from "./account-tools.ts";

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
  readonly native: NativeAccountTools;
  constructor(stateDir: string, tools: AccountTools = {}) {
    this.native = new NativeAccountTools(tools);
    this.root = join(stateDir, "accounts");
    if (existsSync(this.root) && lstatSync(this.root).isSymbolicLink()) throw new FactoryError("account_state_invalid", "The Machine account directory is unavailable", 409);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
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
  }
  overview(): AccountOverview { return { protocol: 1, host_id: this.registry.host_id, profiles: this.registry.profiles.map((entry) => structuredClone(entry.profile)) }; }
  create(body: Record<string, unknown>): AccountProfile {
    if (typeof body.name !== "string" || !body.name.trim() || body.name.length > 100 || !services.includes(body.service as AccountService) || typeof body.expected_login !== "string" || !body.expected_login.trim() || body.expected_login.length > 200 || /[\r\n\0]/.test(body.expected_login)) throw new FactoryError("invalid_account_profile", "Enter a name, supported service and expected login");
    const id = randomUUID(); const now = new Date().toISOString();
    const profile: AccountProfile = { id, revision: randomUUID(), name: body.name.trim(), service: body.service as AccountService, expected_login: body.expected_login.trim(), expected_account_id: null, state: "needs_login", verified_identity: null, public_key: null, fingerprint: null, problem: null, created_at: now, updated_at: now };
    const directory = join(this.root, id);
    mkdirSync(directory, { mode: 0o700 });
    mkdirSync(join(directory, profile.service), { mode: 0o700 });
    this.save({ ...this.registry, profiles: [...this.registry.profiles, { profile, directory }] });
    return structuredClone(profile);
  }
  private entry(id: string): PrivateProfile {
    const entry = this.registry.profiles.find((record) => record.profile.id === id);
    if (!entry) throw new FactoryError("account_not_found", "Account profile not found", 404);
    return entry;
  }
  private update(entry: PrivateProfile, profile: AccountProfile): AccountProfile {
    if (this.entry(profile.id).profile.revision !== entry.profile.revision) throw new FactoryError("account_changed", "The account changed during this operation; refresh before continuing", 409);
    this.save({ ...this.registry, profiles: this.registry.profiles.map((record) => record.profile.id === profile.id ? { ...entry, profile } : record) });
    return structuredClone(profile);
  }
  async verify(id: string, body: Record<string, unknown>): Promise<AccountProfile> {
    const entry = this.entry(id);
    if (entry.profile.revision !== body.expected_revision || entry.profile.state === "disabled") throw new FactoryError("account_changed", "Refresh the enabled account profile before continuing", 409);
    let identity: AccountIdentity;
    try {
    if (entry.profile.service === "github") {
      const result = await this.native.json("github", ["api", "user"], join(entry.directory, "github")) as { login?: unknown; id?: unknown };
      if (typeof result?.login !== "string" || !/^[a-zA-Z0-9-]{1,100}$/.test(result.login)) throw new FactoryError("account_identity_unavailable", "The native CLI did not identify the selected login", 409);
      identity = { login: result.login, account_id: typeof result.id === "number" || typeof result.id === "string" ? String(result.id) : null, auth_method: "oauth" };
    } else throw new FactoryError("account_setup_required", "Finish setup for this native service before verification", 409);
    } catch (error) {
      this.update(entry, { ...entry.profile, state: "needs_login", verified_identity: null, problem: "The selected native login is unavailable; sign in and verify it again", updated_at: new Date().toISOString() });
      throw error instanceof FactoryError ? error : new FactoryError("account_login_unavailable", "The selected native login could not be verified", 409);
    }
    if (identity.login.toLowerCase() !== entry.profile.expected_login.toLowerCase() || entry.profile.expected_account_id !== null && identity.account_id !== entry.profile.expected_account_id) {
      this.update(entry, { ...entry.profile, state: "needs_login", verified_identity: null, problem: "The native login does not match the expected account", updated_at: new Date().toISOString() });
      throw new FactoryError("account_identity_mismatch", "The native login does not match the expected account; no fallback was selected", 409);
    }
    return this.update(entry, { ...entry.profile, state: "ready", verified_identity: identity, problem: null, updated_at: new Date().toISOString() });
  }
  async key(id: string, body: Record<string, unknown>): Promise<AccountProfile> {
    const entry = this.entry(id);
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
}
