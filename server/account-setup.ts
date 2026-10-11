import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AccountProfile, AccountService, AccountSetup } from "../shared/accounts.ts";
import { FactoryError } from "./factory-host.ts";
import { accountProcessEnvironment, type NativeAccountTools } from "./account-tools.ts";

interface Session { status: AccountSetup; child: ChildProcessWithoutNullStreams; timer: ReturnType<typeof setTimeout>; output: string; lease: string }
export const setupLease = (directory: string) => join(directory, ".saurons-sign-in");
const pending = (status: AccountSetup) => ["starting", "authorizing", "verifying", "cancelling"].includes(status.phase);
function argumentsFor(profile: AccountProfile): string[] {
  switch (profile.service) {
    case "github": return ["auth", "login", "--web", "--hostname", "github.com", "--git-protocol", "ssh", "--skip-ssh-key", "--insecure-storage", "--scopes", "admin:public_key"];
    case "codex": return ["-c", 'cli_auth_credentials_store="file"', "login", "--device-auth"];
    case "claude": return ["auth", "login"];
    case "cf": return ["auth", "create", "saurons-" + profile.id, "--no-browser", "--device"];
    case "wrangler": return ["login", "--device", "--browser=false"];
  }
}
function authorizationUrl(service: AccountService, text: string): string | null {
  const allowed: Record<AccountService, string[]> = { github: ["github.com"], codex: ["auth.openai.com"], claude: ["claude.ai", "console.anthropic.com", "platform.claude.com"], cf: ["dash.cloudflare.com"], wrangler: ["dash.cloudflare.com"] };
  for (const candidate of text.match(/https:\/\/[^\s<>"\x1b]+/g) ?? []) {
    try {
      const url = new URL(candidate.replace(/[).,]+$/, ""));
      if (url.username || url.password || !allowed[service].includes(url.hostname)) continue;
      if (service === "github" && url.pathname !== "/login/device") continue;
      if (service === "codex" && url.pathname !== "/codex/device") continue;
      return url.href;
    } catch { /* Native output can contain unrelated diagnostic text. */ }
  }
  return null;
}

/** Sign-in challenges live only in memory and are never part of profile records or factory history. */
export class AccountSetups {
  private readonly sessions = new Map<string, Session>();
  private stopped = false;
  constructor(private readonly tools: NativeAccountTools, private readonly verified: (id: string, revision: string, current: () => boolean) => Promise<AccountProfile>, private readonly finished: (id: string) => void) {}
  recover(directory: string): void {
    const lease = setupLease(directory); if (!existsSync(lease)) return;
    let pid: number;
    try { pid = JSON.parse(readFileSync(join(lease, "process.json"), "utf8")).pid; if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(); }
    catch { throw new FactoryError("account_setup_uncertain", "Preserve this incomplete sign-in lease for operator recovery", 409); }
    try { process.kill(pid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") { rmSync(lease, { recursive: true }); return; } }
    throw new FactoryError("account_setup_busy", "An earlier native sign-in may still be running; finish it before recovery", 409);
  }
  async start(profile: AccountProfile, directory: string): Promise<AccountSetup> {
    if (this.stopped) throw new FactoryError("stopping", "Account setup is stopping", 409);
    const existing = [...this.sessions.values()].find((session) => session.status.profile_id === profile.id && pending(session.status));
    if (existing) return structuredClone(existing.status);
    if ([...this.sessions.values()].filter((session) => pending(session.status)).length >= 4) throw new FactoryError("account_setup_busy", "Finish or cancel another account sign-in first", 409);
    const tool = this.tools.tool(profile.service);
    const lease = setupLease(directory);
    try { mkdirSync(lease, { mode: 0o700 }); }
    catch { throw new FactoryError("account_setup_busy", "Recover the earlier sign-in before starting another", 409); }
    const env = accountProcessEnvironment(profile.service, directory);
    // Native setup must not open a browser on the execution server. The owner opens its challenge.
    env["GH_BROWSER"] = process.platform === "win32" ? "cmd /c exit 0" : "true";
    env["BROWSER"] = env["GH_BROWSER"];
    const child = spawn(tool.executable, [...tool.args ?? [], ...argumentsFor(profile)], { cwd: directory, env, windowsHide: true, stdio: "pipe" });
    const processRecord = join(lease, randomUUID() + ".tmp");
    writeFileSync(processRecord, JSON.stringify({ pid: child.pid ?? null }), { flag: "wx", mode: 0o600 }); renameSync(processRecord, join(lease, "process.json"));
    const status: AccountSetup = { session_id: randomUUID(), profile_id: profile.id, phase: "starting", verification_url: null, user_code: null, problem: null };
    const session: Session = { status, child, output: "", lease, timer: setTimeout(() => { this.cancel(status.session_id); }, 10 * 60_000) };
    for (const [id, previous] of this.sessions) if (!pending(previous.status)) this.sessions.delete(id);
    this.sessions.set(status.session_id, session);
    const consume = (bytes: Buffer) => {
      if (!["starting", "authorizing"].includes(status.phase)) return;
      session.output = (session.output + bytes.toString("utf8").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")).slice(-16_384);
      const url = authorizationUrl(profile.service, session.output);
      if (url) {
        status.verification_url = url; status.phase = "authorizing";
      }
      status.user_code = (url ? new URL(url).searchParams.get("user_code") : null) ?? session.output.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/)?.[1] ?? null;
    };
    child.stdout.on("data", consume); child.stderr.on("data", consume);
    child.stdin.on("error", () => this.cancel(status.session_id));
    child.on("error", () => { if (pending(status)) { clearTimeout(session.timer); rmSync(lease, { recursive: true, force: true }); status.phase = "failed"; status.problem = "The native CLI could not start"; this.finished(profile.id); } });
    child.on("close", (code) => {
      clearTimeout(session.timer); session.output = "";
      if (status.phase === "cancelling") { rmSync(lease, { recursive: true, force: true }); status.phase = "cancelled"; this.finished(profile.id); return; }
      if (!pending(status)) return;
      status.verification_url = null; status.user_code = null;
      if (code !== 0) { rmSync(lease, { recursive: true, force: true }); status.phase = "failed"; status.problem = "Native sign-in did not complete; verify CLI support and try again"; this.finished(profile.id); return; }
      status.phase = "verifying";
      const current = () => !this.stopped && status.phase === "verifying";
      void this.verified(profile.id, profile.revision, current).then((verified) => { if (current()) { rmSync(lease, { recursive: true, force: true }); status.profile = verified; status.phase = "complete"; } }, () => { if (current()) { rmSync(lease, { recursive: true, force: true }); status.phase = "failed"; status.problem = "Sign-in completed but the expected identity was not verified"; this.finished(profile.id); } });
    });
    return structuredClone(status);
  }
  status(id: string, profileId: string): AccountSetup {
    const session = this.sessions.get(id);
    if (!session || session.status.profile_id !== profileId) throw new FactoryError("account_setup_not_found", "This sign-in session is unavailable; verify the account before starting again", 404);
    return structuredClone(session.status);
  }
  async input(id: string, profileId: string, input: unknown): Promise<AccountSetup> {
    const session = this.sessions.get(id);
    if (!session || session.status.profile_id !== profileId || !["starting", "authorizing"].includes(session.status.phase) || session.child.exitCode !== null) throw new FactoryError("account_setup_not_found", "Select the active account sign-in", 409);
    if (typeof input !== "string" || input.length > 4096 || /[\r\n\0\x1b]/.test(input)) throw new FactoryError("invalid_account_input", "Enter one native authorization response");
    session.child.stdin.write(input + "\n");
    return structuredClone(session.status);
  }
  cancel(id: string): AccountSetup {
    const session = this.sessions.get(id);
    if (!session) throw new FactoryError("account_setup_not_found", "Account sign-in not found", 404);
    if (pending(session.status)) {
      session.status.phase = "cancelling"; session.status.verification_url = null; session.status.user_code = null; session.output = "";
      clearTimeout(session.timer);
      if (session.child.exitCode !== null || session.child.signalCode !== null) { rmSync(session.lease, { recursive: true, force: true }); session.status.phase = "cancelled"; this.finished(session.status.profile_id); }
      else { session.child.kill("SIGTERM"); session.timer = setTimeout(() => { if (session.child.exitCode === null && session.child.signalCode === null) session.child.kill("SIGKILL"); }, 2000); }
    }
    return structuredClone(session.status);
  }
  stop(): void { this.stopped = true; for (const session of this.sessions.values()) if (pending(session.status)) this.cancel(session.status.session_id); }
}
