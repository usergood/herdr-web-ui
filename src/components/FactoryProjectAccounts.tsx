import { useEffect, useRef, useState } from "react";
import type { AccountOverview, AccountProfile, AccountService, AccountSetup, AccountState, ProjectAccountBindings } from "../../shared/accounts.ts";
import type { FactoryProject } from "../../shared/protocol.ts";
import { accountRequest } from "../lib/accountsApi.ts";
import { useT } from "../lib/i18n.ts";

const services: AccountService[] = ["github", "codex", "claude", "cf", "wrangler"];
const names: Record<AccountService, string> = { github: "GitHub", codex: "Codex", claude: "Claude", cf: "Cloudflare cf", wrangler: "Wrangler" };
function stateLabel(state: AccountState, t: ReturnType<typeof useT>): string {
  switch (state) { case "needs_login": return t("Needs sign-in"); case "ready": return t("Ready"); case "disabled": return t("Disabled"); case "setting_up": return t("Signing in"); case "failed": return t("Failed"); }
}
function bindingLabel(service: AccountService, t: ReturnType<typeof useT>): string {
  switch (service) { case "github": return t("GitHub profile"); case "codex": return t("Codex profile"); case "claude": return t("Claude profile"); case "cf": return t("Cloudflare profile"); case "wrangler": return t("Wrangler profile"); }
}

export function FactoryProjectAccounts({ project, machineId, busy, perform }: { project: FactoryProject; machineId: string; busy: boolean; perform: (action: () => Promise<void>) => Promise<void> }) {
  const t = useT(); const prefix = `/machines/${encodeURIComponent(machineId)}/accounts`;
  const [overview, setOverview] = useState<AccountOverview | null>(null); const [problem, setProblem] = useState<string | null>(null);
  const [name, setName] = useState(""); const [service, setService] = useState<AccountService>("github"); const [login, setLogin] = useState(""); const [accountId, setAccountId] = useState("");
  const [bindings, setBindings] = useState<ProjectAccountBindings>(project.account_bindings?.[machineId] ?? {}); const [saved, setSaved] = useState(false);
  const [setup, setSetup] = useState<AccountSetup | null>(null); const setupStarted = useRef(0);
  const [editing, setEditing] = useState<string | null>(null);
  const epoch = useRef(0); const bindingSignature = JSON.stringify(project.account_bindings?.[machineId] ?? {});
  useEffect(() => { setBindings(JSON.parse(bindingSignature)); }, [bindingSignature]);
  async function reload(current = epoch.current): Promise<void> { const value = await accountRequest<AccountOverview>(prefix); if (current === epoch.current) setOverview(value); }
  useEffect(() => {
    const controller = new AbortController(); const current = ++epoch.current; setOverview(null); setProblem(null); setSetup(null);
    void accountRequest<AccountOverview>(prefix, undefined, controller.signal).then((value) => { if (current === epoch.current) setOverview(value); }, (error: unknown) => { if (!controller.signal.aborted && current === epoch.current) setProblem(error instanceof Error ? error.message : t("Accounts unavailable")); });
    return () => { epoch.current++; controller.abort(); };
  }, [prefix]);
  useEffect(() => {
    if (!setup || !["starting", "authorizing", "verifying", "cancelling"].includes(setup.phase)) return;
    let live = true; const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const selected = setup;
    const poll = async () => {
      if (Date.now() - setupStarted.current > 10 * 60_000) { setProblem(t("Sign-in timed out. Verify the account before trying again.")); return; }
      try {
        const value = await accountRequest<AccountSetup>(`${prefix}/${selected.profile_id}/setup/status`, { session_id: selected.session_id }, controller.signal);
        if (!live) return; setSetup(value);
        if (value.phase === "complete" || value.phase === "failed" || value.phase === "cancelled") await reload();
        else timer = setTimeout(() => void poll(), 1000);
      } catch (error) { if (live && !controller.signal.aborted) setProblem(error instanceof Error ? error.message : t("Accounts unavailable")); }
    };
    void poll(); return () => { live = false; clearTimeout(timer); controller.abort(); };
  }, [prefix, setup?.session_id, setup?.phase]);

  const action = (operation: (current: number) => Promise<void>) => { const current = epoch.current; return perform(async () => { setProblem(null); await operation(current); if (current === epoch.current) await reload(current); }); };
  const operate = (profile: AccountProfile, operation: string) => action(async (current) => {
    if (operation === "setup") { setupStarted.current = Date.now(); const value = await accountRequest<AccountSetup>(`${prefix}/${profile.id}/setup`, { expected_revision: profile.revision }); if (current === epoch.current) setSetup(value); }
    else await accountRequest(`${prefix}/${profile.id}/${operation}`, { expected_revision: profile.revision });
  });
  return <section className="factory-section" aria-label={t("Project accounts")}>
    <h3>{t("Project accounts")}</h3><p>{t("Accounts stay on this Machine. Codex and Claude use subscription sign-in.")}</p>
    {problem && <p role="alert" className="error-state">{problem}</p>}
    {!overview && !problem && <p role="status">{t("Loading…")}</p>}
    <form className="factory-form" onSubmit={(event) => { event.preventDefault(); void action(async () => { await accountRequest(prefix, { name, service, expected_login: login, ...((service === "cf" || service === "wrangler") ? { expected_account_id: accountId } : {}) }); setName(""); setLogin(""); setAccountId(""); }); }}>
      <label>{t("Account name")}<input className="input factory-input" required value={name} maxLength={100} onChange={(event) => setName(event.target.value)} /></label>
      <label>{t("Account service")}<select className="select factory-input" value={service} onChange={(event) => setService(event.target.value as AccountService)}>{services.map((kind) => <option key={kind} value={kind}>{names[kind]}</option>)}</select></label>
      <label>{t("Expected login")}<input className="input factory-input" required value={login} maxLength={200} onChange={(event) => setLogin(event.target.value)} /></label>
      {(service === "cf" || service === "wrangler") && <label>{t("Cloudflare account ID")}<input className="input factory-input" required value={accountId} maxLength={32} onChange={(event) => setAccountId(event.target.value)} /></label>}
      <button className="btn factory-button" disabled={busy || !overview}>{t("Create account profile")}</button>
    </form>
    {overview?.profiles.map((profile) => <article className="factory-artifact" key={profile.id}>
      <h4>{profile.name}</h4><p>{names[profile.service]} · {profile.expected_login} · <span role="status">{stateLabel(profile.state, t)}</span></p>
      {profile.expected_account_id && <p>{profile.expected_account_id}</p>}{profile.problem && <p role="status">{profile.problem}</p>}
      <div className="factory-actions">
        <button className="btn factory-button" disabled={busy || profile.state === "setting_up"} onClick={() => setEditing(profile.id)}>{t("Edit account profile")}</button>
        <button className="btn factory-button" disabled={busy || profile.state === "disabled"} onClick={() => void operate(profile, "setup")}>{t("Start sign-in")}</button>
        <button className="btn factory-button" disabled={busy || profile.state === "disabled"} onClick={() => void operate(profile, "verify")}>{t("Verify account identity")}</button>
        {profile.service === "github" && <><button className="btn factory-button" disabled={busy || profile.state === "disabled" || Boolean(profile.public_key)} onClick={() => void operate(profile, "key")}>{t("Generate managed SSH key")}</button><button className="btn factory-button" disabled={busy || !profile.public_key || Boolean(profile.github_key_id)} onClick={() => void operate(profile, "register-key")}>{t("Register public key with GitHub")}</button></>}
        <button className="btn factory-button" disabled={busy || profile.state === "disabled"} onClick={() => void operate(profile, "disable")}>{t("Disable account profile")}</button>
        {profile.state === "setting_up" && <button className="btn factory-button" disabled={busy} onClick={() => void operate(profile, "recover")}>{t("Recover interrupted sign-in")}</button>}
      </div>
      {editing === profile.id && <form className="factory-form" onSubmit={(event) => { event.preventDefault(); const values = new FormData(event.currentTarget); void action(async (current) => { await accountRequest(`${prefix}/${profile.id}/configure`, { expected_revision: profile.revision, name: values.get("name"), expected_login: values.get("login"), expected_account_id: values.get("account") || null }); if (current === epoch.current) setEditing(null); }); }}>
        <label>{t("Account name")}<input className="input factory-input" required name="name" defaultValue={profile.name} maxLength={100} /></label>
        <label>{t("Expected login")}<input className="input factory-input" required name="login" defaultValue={profile.expected_login} maxLength={200} /></label>
        {(profile.service === "cf" || profile.service === "wrangler") && <label>{t("Cloudflare account ID")}<input className="input factory-input" required name="account" defaultValue={profile.expected_account_id ?? ""} maxLength={32} /></label>}
        <button className="btn factory-button" disabled={busy}>{t("Save account profile")}</button>
      </form>}
      {profile.fingerprint && <p>{profile.fingerprint}</p>}{profile.github_key_id && <p role="status">{t("Public key registered")}</p>}
      {profile.public_key && <details><summary>{t("Public SSH key")}</summary><pre>{profile.public_key}</pre></details>}
    </article>)}
    {setup && <div className="factory-artifact" role="status">
      <p>{setup.phase === "complete" ? t("Account sign-in completed") : setup.problem ?? t("Complete authorization in your browser, then return here.")}</p>
      {setup.verification_url && <a className="btn factory-button" href={setup.verification_url} target="_blank" rel="noopener noreferrer">{t("Open authorization page")}</a>}
      {setup.user_code && <p><code>{setup.user_code}</code></p>}
      {["starting", "authorizing"].includes(setup.phase) && <>
        <button className="btn factory-button" disabled={busy} onClick={() => void action(async () => { setSetup(await accountRequest(`${prefix}/${setup.profile_id}/setup/input`, { session_id: setup.session_id, input: "" })); })}>{t("Continue sign-in")}</button>
        <form className="factory-form" onSubmit={(event) => { event.preventDefault(); const form = event.currentTarget; const value = String(new FormData(form).get("authorization-response") ?? ""); form.reset(); void action(async () => { setSetup(await accountRequest(`${prefix}/${setup.profile_id}/setup/input`, { session_id: setup.session_id, input: value })); }); }}><label>{t("Native authorization response")}<input className="input factory-input" name="authorization-response" type="password" autoComplete="off" maxLength={4096} /></label><button className="btn factory-button" disabled={busy}>{t("Send authorization response")}</button></form>
        <button className="btn factory-button" disabled={busy} onClick={() => void action(async () => { setSetup(await accountRequest(`${prefix}/${setup.profile_id}/setup/cancel`, { session_id: setup.session_id })); })}>{t("Cancel sign-in")}</button>
      </>}
    </div>}
    <form className="factory-form" onSubmit={(event) => { event.preventDefault(); void action(async () => { await accountRequest(`/projects/${project.id}/configure`, { account_bindings: { ...project.account_bindings, [machineId]: bindings } }); setSaved(true); }); }}>
      {services.map((kind) => <label key={kind}>{bindingLabel(kind, t)}<select className="select factory-input" value={bindings[kind] ?? ""} onChange={(event) => { setSaved(false); const value = event.target.value; setBindings((current) => { const next = { ...current }; if (value) next[kind] = value; else delete next[kind]; return next; }); }}><option value="">{t("Current Machine account")}</option>{overview?.profiles.filter((profile) => profile.service === kind && profile.state === "ready").map((profile) => <option value={profile.id} key={profile.id}>{profile.name}</option>)}</select></label>)}
      <button className="btn factory-button" disabled={busy || !overview}>{t("Save Project accounts")}</button>
      {saved && <p role="status">{t("Project accounts saved")}</p>}
    </form>
  </section>;
}
