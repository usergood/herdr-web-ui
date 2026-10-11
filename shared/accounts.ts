/** Public Machine account contract; native credentials and paths are never wire fields.
 * GET/POST /api/factory/machines/:machine/accounts -> AccountOverview / AccountProfile.
 * POST .../accounts/:id/(configure|key|setup|verify|register-key|disable) -> AccountProfile.
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
  problem: string | null; created_at: string; updated_at: string;
}
export interface AccountOverview { protocol: 1; host_id: string; profiles: AccountProfile[] }
export type ProjectAccountBindings = Partial<Record<AccountService, string>>;
export interface AccountBindingSnapshot { host_id: string; profiles: { id: string; revision: string; service: AccountService; identity: AccountIdentity }[] }
