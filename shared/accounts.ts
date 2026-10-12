/** Public Machine account contract; native credentials and paths are never wire fields.
 * GET/POST /api/factory/machines/:machine/accounts -> AccountOverview / AccountProfile.
 * POST .../accounts/:id/(configure|key|verify|register-key|disable|recover) -> AccountProfile.
 * POST .../accounts/:id/setup and setup/(status|input|cancel) -> AccountSetup.
 * The corresponding /api/factory-host/accounts routes operate only on that execution host.
 */
export type AccountService = "github" | "codex" | "claude" | "cf" | "wrangler";
export type AccountState = "needs_login" | "ready" | "disabled" | "setting_up" | "failed";
export interface AccountIdentity { login: string; account_id: string | null; auth_method: "oauth" | "subscription" | "api_token" }
export interface AccountProfile {
  id: string; revision: string; name: string; service: AccountService;
  expected_login: string; expected_account_id: string | null;
  state: AccountState; verified_identity: AccountIdentity | null;
  public_key: string | null; fingerprint: string | null;
  github_key_id?: number | null;
  problem: string | null; created_at: string; updated_at: string;
}
export interface AccountOverview { protocol: 1; host_id: string; profiles: AccountProfile[] }
export interface NativeAccountSource { id: string; service: "github"; login: string; active: boolean; available: boolean; existing_profile_id: string | null }
export interface NativeAccountDiscovery { protocol: 1; sources: NativeAccountSource[]; warnings: string[] }
export interface AccountSetup {
  session_id: string; profile_id: string;
  phase: "starting" | "authorizing" | "verifying" | "cancelling" | "complete" | "failed" | "cancelled";
  verification_url: string | null; user_code: string | null;
  problem: string | null; profile?: AccountProfile;
}
export type ProjectAccountBindings = Partial<Record<AccountService, string>>;
export interface AccountBindingSnapshot { host_id: string; profiles: { id: string; revision: string; service: AccountService; identity: AccountIdentity }[] }
