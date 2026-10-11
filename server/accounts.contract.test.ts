import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createServer } from "./index.ts";
import { herdrRpc, workspaceClose, workspaceCreate } from "./herdr/client.ts";

describe("Machine account profiles through the owner HTTP interface", () => {
  const roots: string[] = [];
  const apps: ReturnType<typeof createServer>[] = [];
  const headers = { authorization: "Bearer account-contract-owner", "content-type": "application/json", "x-herdr-factory": "1", "x-herdr-machine": "1" };
  function app(stateDir?: string, githubFixture?: string, codexFixture?: string, claudeFixture?: string, cloudflareFixture?: string) {
    const state = stateDir ?? mkdtempSync(join(tmpdir(), "saurons-accounts-contract-"));
    if (!stateDir) roots.push(state);
    const accountTools = { ...(githubFixture ? { github: { executable: process.execPath, args: [githubFixture] } } : {}), ...(codexFixture ? { codex: { executable: process.execPath, args: [codexFixture] } } : {}), ...(claudeFixture ? { claude: { executable: process.execPath, args: [claudeFixture] } } : {}), ...(cloudflareFixture ? { cf: { executable: process.execPath, args: [cloudflareFixture] }, wrangler: { executable: process.execPath, args: [cloudflareFixture] } } : {}) };
    const server = createServer({ port: 0, stateDir: state, token: "account-contract-owner", machines: false, ...(Object.keys(accountTools).length ? { factory: { accountTools } } : {}) });
    apps.push(server);
    return { server, state, origin: `http://localhost:${server.port}` };
  }
  afterEach(() => { for (const server of apps.splice(0)) server.stop(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

  test("the owner can keep two distinct GitHub account profiles across a restart without exposing credentials", async () => {
    const first = app();
    const route = "/api/factory/machines/local/accounts";
    const response = await fetch(first.origin + route, { method: "POST", headers, body: JSON.stringify({ name: "Work GitHub", service: "github", expected_login: "fictional-work" }) });
    expect(response.status).toBe(201);
    const work = await response.json();
    expect(work.name).toBe("Work GitHub");
    expect(work.service).toBe("github");
    expect(work.state).toBe("needs_login");
    expect(work.verified_identity).toBeNull();
    const personalResponse = await fetch(first.origin + route, { method: "POST", headers, body: JSON.stringify({ name: "Personal GitHub", service: "github", expected_login: "fictional-personal" }) });
    expect(personalResponse.status).toBe(201);
    const personal = await personalResponse.json();
    expect(personal.id).not.toBe(work.id);
    first.server.stop();
    const restarted = app(first.state);
    const listed = await (await fetch(restarted.origin + route, { headers })).json();
    expect(listed.profiles.map((profile: { id: string }) => profile.id).sort()).toEqual([work.id, personal.id].sort());
    expect(JSON.stringify(listed)).not.toContain("private_key");
    expect(JSON.stringify(listed)).not.toContain("auth.json");
    expect(JSON.stringify(listed)).not.toContain(first.state);
    expect((await fetch(restarted.origin + route)).status).toBe(401);
  });

  test("the owner generates a profile-owned Ed25519 key once and receives only its public material", async () => {
    const current = app(); const route = "/api/factory/machines/local/accounts";
    const profile = await (await fetch(current.origin + route, { method: "POST", headers, body: JSON.stringify({ name: "Key fixture", service: "github", expected_login: "fictional-key-owner" }) })).json();
    let revision = profile.revision;
    const request = () => fetch(`${current.origin}${route}/${profile.id}/key`, { method: "POST", headers, body: JSON.stringify({ expected_revision: revision }) });
    const generated = await request();
    expect(generated.status).toBe(200);
    const result = await generated.json();
    expect(result.public_key).toMatch(/^ssh-ed25519 [A-Za-z0-9+/=]+ /);
    expect(result.fingerprint).toMatch(/^SHA256:/);
    expect(JSON.stringify(result)).not.toContain("PRIVATE KEY");
    expect(JSON.stringify(result)).not.toContain(current.state);
    revision = result.revision;
    const repeated = await request();
    expect(repeated.status).toBe(200);
    expect((await repeated.json()).public_key).toBe(result.public_key);
    expect(result.state).toBe("needs_login");
  });

  test("verification reports the selected native login while discarding token fields and private native paths", async () => {
    const state = mkdtempSync(join(tmpdir(), "saurons-accounts-native-")); roots.push(state);
    const fixture = join(state, "github-cli.mjs");
    writeFileSync(fixture, 'process.stdout.write(JSON.stringify({ login: "fictional-work", id: 1042, token: "owned-native-token-must-stay-private", config_path: process.env.GH_CONFIG_DIR }) + "\\n");\n');
    const current = app(state, fixture); const route = "/api/factory/machines/local/accounts";
    const profile = await (await fetch(current.origin + route, { method: "POST", headers, body: JSON.stringify({ name: "Verified work", service: "github", expected_login: "fictional-work" }) })).json();
    const response = await fetch(`${current.origin}${route}/${profile.id}/verify`, { method: "POST", headers, body: JSON.stringify({ expected_revision: profile.revision }) });
    expect(response.status).toBe(200);
    const verified = await response.json();
    expect(verified.state).toBe("ready");
    expect(verified.verified_identity).toEqual({ login: "fictional-work", account_id: "1042", auth_method: "oauth" });
    expect(JSON.stringify(verified)).not.toContain("owned-native-token-must-stay-private");
    expect(JSON.stringify(verified)).not.toContain(state);
  });

  test("an expired selected login loses readiness instead of falling back to another account", async () => {
    const state = mkdtempSync(join(tmpdir(), "saurons-accounts-expired-")); roots.push(state);
    const fixture = join(state, "github-cli.mjs");
    writeFileSync(fixture, 'process.stdout.write(JSON.stringify({ login: "fictional-work", id: 1042 }) + "\\n");\n');
    const current = app(state, fixture); const route = "/api/factory/machines/local/accounts";
    const profile = await (await fetch(current.origin + route, { method: "POST", headers, body: JSON.stringify({ name: "Expiry fixture", service: "github", expected_login: "fictional-work" }) })).json();
    const verify = () => fetch(`${current.origin}${route}/${profile.id}/verify`, { method: "POST", headers, body: JSON.stringify({ expected_revision: profile.revision }) });
    expect((await verify()).status).toBe(200);
    writeFileSync(fixture, 'process.stderr.write("owned-expired-token-do-not-disclose"); process.exit(1);\n');
    const expired = await verify();
    expect(expired.status).toBe(409);
    expect(await expired.text()).not.toContain("owned-expired-token");
    const listed = await (await fetch(current.origin + route, { headers })).json();
    expect(listed.profiles[0].state).toBe("needs_login");
    expect(listed.profiles[0].verified_identity).toBeNull();
  });

  test("native sign-in exposes an owner-only authorization challenge and verifies the completed selected account", async () => {
    const state = mkdtempSync(join(tmpdir(), "saurons-accounts-setup-")); roots.push(state);
    const fixture = join(state, "github-cli.mjs");
    writeFileSync(fixture, `import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const cache = join(process.env.GH_CONFIG_DIR, "owned-login.json");
if (process.argv.includes("login")) {
  process.stdout.write("First copy your one-time code: ABCD-1234\\nOpen https://github.com/login/device\\n");
  process.stdin.once("data", () => { writeFileSync(cache, JSON.stringify({ login: "fictional-work", token: "owned-setup-token-never-expose" })); process.exit(0); });
} else if (existsSync(cache)) process.stdout.write(JSON.stringify({ login: "fictional-work", id: 1042 }));
else process.exit(1);
`);
    const current = app(state, fixture); const route = "/api/factory/machines/local/accounts";
    const profile = await (await fetch(current.origin + route, { method: "POST", headers, body: JSON.stringify({ name: "Sign-in fixture", service: "github", expected_login: "fictional-work" }) })).json();
    const begin = await fetch(`${current.origin}${route}/${profile.id}/setup`, { method: "POST", headers, body: JSON.stringify({ expected_revision: profile.revision }) });
    expect(begin.status).toBe(202);
    const started = await begin.json();
    const status = async () => (await fetch(`${current.origin}${route}/${profile.id}/setup/status`, { method: "POST", headers, body: JSON.stringify({ session_id: started.session_id }) })).json();
    let challenge = await status(); const deadline = Date.now() + 5000;
    while (challenge.phase !== "authorizing" && Date.now() < deadline) { await Bun.sleep(25); challenge = await status(); }
    expect(challenge.verification_url).toBe("https://github.com/login/device");
    expect(challenge.user_code).toBe("ABCD-1234");
    const publicList = await (await fetch(current.origin + route, { headers })).text();
    expect(publicList).not.toContain("ABCD-1234");
    expect(publicList).not.toContain("owned-setup-token");
    expect((await fetch(`${current.origin}${route}/${profile.id}/setup/input`, { method: "POST", headers, body: JSON.stringify({ session_id: started.session_id, input: "" }) })).status).toBe(202);
    let complete = await status();
    while (complete.phase !== "complete" && Date.now() < deadline) { await Bun.sleep(25); complete = await status(); }
    expect(complete.phase).toBe("complete");
    expect(complete.profile.verified_identity.login).toBe("fictional-work");
    expect(JSON.stringify(complete)).not.toContain("owned-setup-token");
  });

  test("an active native sign-in excludes identity verification and setup from another server until cancellation releases ownership", async () => {
    const state = mkdtempSync(join(tmpdir(), "saurons-accounts-ownership-")); roots.push(state);
    const fixture = join(state, "github-cli.mjs");
    writeFileSync(fixture, `if (process.argv.includes("login")) { process.stdout.write("Open https://github.com/login/device\\n"); process.stdin.resume(); } else process.stdout.write(JSON.stringify({ login: "fictional-work", id: 1042 }));\n`);
    const first = app(state, fixture); const route = "/api/factory/machines/local/accounts";
    const profile = await (await fetch(first.origin + route, { method: "POST", headers, body: JSON.stringify({ name: "Owned sign-in", service: "github", expected_login: "fictional-work" }) })).json();
    const started = await (await fetch(`${first.origin}${route}/${profile.id}/setup`, { method: "POST", headers, body: JSON.stringify({ expected_revision: profile.revision }) })).json();
    expect((await fetch(`${first.origin}${route}/${profile.id}/verify`, { method: "POST", headers, body: JSON.stringify({ expected_revision: profile.revision }) })).status).toBe(409);
    const second = app(state, fixture);
    expect((await fetch(`${second.origin}${route}/${profile.id}/setup`, { method: "POST", headers, body: JSON.stringify({ expected_revision: profile.revision }) })).status).toBe(409);
    await fetch(`${first.origin}${route}/${profile.id}/setup/cancel`, { method: "POST", headers, body: JSON.stringify({ session_id: started.session_id }) });
    const deadline = Date.now() + 5000; let status;
    do { status = await (await fetch(`${first.origin}${route}/${profile.id}/setup/status`, { method: "POST", headers, body: JSON.stringify({ session_id: started.session_id }) })).json(); if (status.phase === "cancelled") break; await Bun.sleep(25); } while (Date.now() < deadline);
    expect(status.phase).toBe("cancelled");
    expect((await (await fetch(first.origin + route, { headers })).json()).profiles[0].state).toBe("needs_login");
  });

  test("Codex verification accepts the chosen subscription identity and rejects API-key billing", async () => {
    const state = mkdtempSync(join(tmpdir(), "saurons-accounts-codex-")); roots.push(state);
    const fixture = join(state, "codex-cli.mjs");
    const script = (type: string) => `import { createInterface } from "node:readline";
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") process.stdout.write(JSON.stringify({ id: message.id, result: { userAgent: "owned-fixture" } }) + "\\n");
  if (message.method === "account/read") process.stdout.write(JSON.stringify({ id: message.id, result: { account: { type: ${JSON.stringify(type)}, email: "work@example.test", planType: "plus", token: "owned-codex-token-never-expose" } } }) + "\\n");
});\n`;
    writeFileSync(fixture, script("chatgpt"));
    const current = app(state, undefined, fixture); const route = "/api/factory/machines/local/accounts";
    const profile = await (await fetch(current.origin + route, { method: "POST", headers, body: JSON.stringify({ name: "Work Codex", service: "codex", expected_login: "work@example.test" }) })).json();
    const verify = () => fetch(`${current.origin}${route}/${profile.id}/verify`, { method: "POST", headers, body: JSON.stringify({ expected_revision: profile.revision }) });
    const response = await verify(); expect(response.status).toBe(200);
    const subscribed = await response.json();
    expect(subscribed.verified_identity).toEqual({ login: "work@example.test", account_id: null, auth_method: "subscription" });
    expect(JSON.stringify(subscribed)).not.toContain("owned-codex-token");
    writeFileSync(fixture, script("apiKey"));
    const apiKey = await verify(); expect(apiKey.status).toBe(409);
    expect((await apiKey.json()).error.code).toBe("account_subscription_required");
  });

  test("Claude verification requires subscription billing and the selected native configuration directory", async () => {
    const state = mkdtempSync(join(tmpdir(), "saurons-accounts-claude-")); roots.push(state);
    const fixture = join(state, "claude-cli.mjs");
    const script = (method: string) => `process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: ${JSON.stringify(method)}, email: "claude-work@example.test", configDirectory: process.env.CLAUDE_CONFIG_DIR, oauth_token: "owned-claude-token-never-expose" }));\n`;
    writeFileSync(fixture, script("claude.ai"));
    const current = app(state, undefined, undefined, fixture); const route = "/api/factory/machines/local/accounts";
    const profile = await (await fetch(current.origin + route, { method: "POST", headers, body: JSON.stringify({ name: "Work Claude", service: "claude", expected_login: "claude-work@example.test" }) })).json();
    const verify = () => fetch(`${current.origin}${route}/${profile.id}/verify`, { method: "POST", headers, body: JSON.stringify({ expected_revision: profile.revision }) });
    const response = await verify(); expect(response.status).toBe(200);
    const subscribed = await response.json();
    expect(subscribed.verified_identity.auth_method).toBe("subscription");
    expect(JSON.stringify(subscribed)).not.toContain("owned-claude-token");
    expect(JSON.stringify(subscribed)).not.toContain(state);
    writeFileSync(fixture, script("api_key"));
    const api = await verify(); expect(api.status).toBe(409);
    expect((await api.json()).error.code).toBe("account_subscription_required");
  });

  test("Cloudflare native profiles verify the specified account instead of selecting a default membership", async () => {
    const state = mkdtempSync(join(tmpdir(), "saurons-accounts-cloudflare-")); roots.push(state);
    const fixture = join(state, "cloudflare-cli.mjs"); const accountId = "1".repeat(32);
    writeFileSync(fixture, `const args = process.argv.slice(2); if (args[0] === "auth" ? !args.includes("--profile") : args.includes("--profile") || process.env.HOME !== process.env.XDG_CONFIG_HOME) process.exit(1); process.stdout.write(JSON.stringify({ authenticated: true, tokenValid: true, email: "cf-work@example.test", accounts: [{ id: ${JSON.stringify(accountId)}, name: "Fictional account" }], token: "owned-cf-token-never-expose" }));\n`);
    const current = app(state, undefined, undefined, undefined, fixture); const route = "/api/factory/machines/local/accounts";
    for (const service of ["cf", "wrangler"]) {
      const profile = await (await fetch(current.origin + route, { method: "POST", headers, body: JSON.stringify({ name: `Work ${service}`, service, expected_login: "cf-work@example.test", expected_account_id: accountId }) })).json();
      const verifiedResponse = await fetch(`${current.origin}${route}/${profile.id}/verify`, { method: "POST", headers, body: JSON.stringify({ expected_revision: profile.revision }) });
      expect(verifiedResponse.status).toBe(200);
      const verified = await verifiedResponse.json();
      expect(verified.verified_identity.account_id).toBe(accountId);
      expect(JSON.stringify(verified)).not.toContain("owned-cf-token");
      expect(JSON.stringify(verified)).not.toContain(state);
    }
  });

  test("registering a managed GitHub key checks the selected account and reconciles an existing matching public key", async () => {
    const state = mkdtempSync(join(tmpdir(), "saurons-accounts-register-")); roots.push(state);
    const fixture = join(state, "github-cli.mjs");
    writeFileSync(fixture, `import { existsSync, readFileSync, writeFileSync } from "node:fs"; import { join } from "node:path";
const saved = join(process.env.GH_CONFIG_DIR, "owned-key.json");
if (process.argv.includes("user/keys")) {
  if (process.argv.includes("POST")) { if (existsSync(saved)) process.exit(2); const key = process.argv.find((value) => value.startsWith("key=")).slice(4); const result = { id: 1042, key }; writeFileSync(saved, JSON.stringify(result)); process.stdout.write(JSON.stringify(result)); }
  else process.stdout.write(JSON.stringify(existsSync(saved) ? [JSON.parse(readFileSync(saved, "utf8"))] : []));
} else process.stdout.write(JSON.stringify({ login: "fictional-work", id: 77 }));\n`);
    const current = app(state, fixture); const route = "/api/factory/machines/local/accounts";
    let profile = await (await fetch(current.origin + route, { method: "POST", headers, body: JSON.stringify({ name: "Registered key", service: "github", expected_login: "fictional-work" }) })).json();
    profile = await (await fetch(`${current.origin}${route}/${profile.id}/key`, { method: "POST", headers, body: JSON.stringify({ expected_revision: profile.revision }) })).json();
    const register = () => fetch(`${current.origin}${route}/${profile.id}/register-key`, { method: "POST", headers, body: JSON.stringify({ expected_revision: profile.revision }) });
    const response = await register(); expect(response.status).toBe(200);
    profile = await response.json(); expect(profile.github_key_id).toBe(1042);
    expect(profile.verified_identity.login).toBe("fictional-work");
    const repeated = await register(); expect(repeated.status).toBe(200);
    expect((await repeated.json()).github_key_id).toBe(1042);
  });

  test("a Project binds a verified Machine profile and receives a credential-free versioned execution snapshot", async () => {
    const state = mkdtempSync(join(tmpdir(), "saurons-accounts-project-")); roots.push(state);
    const fixture = join(state, "github-cli.mjs");
    writeFileSync(fixture, 'process.stdout.write(JSON.stringify({ login: "fictional-work", id: 1042, token: "owned-binding-token-never-expose" }));\n');
    execFileSync("git", ["init", "-b", "main", join(state, "repo")], { stdio: "ignore" });
    writeFileSync(join(state, "repo", "README.md"), "# Owned account binding fixture\n");
    execFileSync("git", ["add", "."], { cwd: join(state, "repo") });
    execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "fixture"], { cwd: join(state, "repo"), stdio: "ignore" });
    const current = app(state, fixture); const route = "/api/factory/machines/local/accounts";
    const profile = await (await fetch(current.origin + route, { method: "POST", headers, body: JSON.stringify({ name: "Project work", service: "github", expected_login: "fictional-work" }) })).json();
    expect((await fetch(`${current.origin}${route}/${profile.id}/verify`, { method: "POST", headers, body: JSON.stringify({ expected_revision: profile.revision }) })).status).toBe(200);
    const project = await (await fetch(current.origin + "/api/factory/projects", { method: "POST", headers, body: JSON.stringify({ name: "Owned Project", path: join(state, "repo"), machine_id: "local", provider: "codex", tracker: "app" }) })).json();
    const configured = await fetch(`${current.origin}/api/factory/projects/${project.id}/configure`, { method: "POST", headers, body: JSON.stringify({ account_bindings: { local: { github: profile.id } } }) });
    expect(configured.status).toBe(200);
    expect((await configured.json()).account_bindings.local.github).toBe(profile.id);
    const snapshotResponse = await fetch(`${current.origin}/api/factory/projects/${project.id}/accounts/verify`, { method: "POST", headers, body: JSON.stringify({ machine_id: "local" }) });
    expect(snapshotResponse.status).toBe(200);
    const snapshot = await snapshotResponse.json();
    expect(snapshot.profiles).toEqual([{ id: profile.id, revision: profile.revision, service: "github", identity: { login: "fictional-work", account_id: "1042", auth_method: "oauth" } }]);
    expect(JSON.stringify(snapshot)).not.toContain("owned-binding-token");
    expect(JSON.stringify(snapshot)).not.toContain(state);
  });

  test("an accepted Run freezes its Project account revision before native allocation", async () => {
    const state = mkdtempSync(join(tmpdir(), "saurons-accounts-run-")); roots.push(state);
    const fixture = join(state, "github-cli.mjs"); writeFileSync(fixture, 'process.stdout.write(JSON.stringify({ login: "fictional-work", id: 1042 }));\n');
    const repo = join(state, "repo"); execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" }); writeFileSync(join(repo, "README.md"), "# Owned Run fixture\n");
    execFileSync("git", ["add", "."], { cwd: repo }); execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "fixture"], { cwd: repo, stdio: "ignore" });
    const server = createServer({ port: 0, stateDir: state, token: "account-contract-owner", machines: false, factory: { accountTools: { github: { executable: process.execPath, args: [fixture] } }, native: { version: async () => "owned-native-fixture", createWorkspace: async () => { throw new Error("No native allocation in this acceptance test"); } } } }); apps.push(server);
    const origin = `http://localhost:${server.port}`;
    const post = async (path: string, body: unknown) => { const response = await fetch(origin + "/api/factory" + path, { method: "POST", headers, body: JSON.stringify(body) }); expect(response.ok).toBe(true); return response.json(); };
    const profile = await post("/machines/local/accounts", { name: "Run work", service: "github", expected_login: "fictional-work" });
    await post(`/machines/local/accounts/${profile.id}/verify`, { expected_revision: profile.revision });
    const project = await post("/projects", { name: "Run Project", path: repo, machine_id: "local", provider: "codex", tracker: "app" });
    await post(`/projects/${project.id}/configure`, { account_bindings: { local: { github: profile.id } }, checks: [["bun", "test"]], permissions: "Owned fixtures only; no publication" });
    const idea = await post("/implementations", { title: "Frozen account fixture", description: "Owned context" });
    await post(`/implementations/${idea.id}/configure`, { project_id: project.id });
    const run = await post(`/implementations/${idea.id}/runs`, { action: "setup", idempotency_key: "frozen-account-fixture" });
    expect(run.manifest.account_snapshot.profiles[0].id).toBe(profile.id);
    expect(run.manifest.account_snapshot.profiles[0].revision).toBe(profile.revision);
    expect(JSON.stringify(run.manifest.account_snapshot)).not.toContain(state);
  });

  test("native execution receives the frozen GitHub profile instead of ambient credentials", async () => {
    const state = mkdtempSync(join(tmpdir(), "saurons-accounts-environment-")); roots.push(state);
    const fixture = join(state, "github-cli.mjs");
    writeFileSync(fixture, `import { existsSync, readFileSync, writeFileSync } from "node:fs"; import { join } from "node:path";
const cache = process.env.GH_CONFIG_DIR ? join(process.env.GH_CONFIG_DIR, "owned-account-fixture.json") : null;
if (process.argv.includes("--fixture-signin") && cache) writeFileSync(cache, JSON.stringify({ login: "fictional-work", id: 1042 }));
if (process.argv.includes("git-credential")) { const input = await Bun.stdin.text(); if (!input.includes("host=github.com")) process.exit(1); process.stdout.write("username=fictional-work\\npassword=owned-https-credential\\n"); process.exit(0); }
process.stdout.write(JSON.stringify(cache && existsSync(cache) ? JSON.parse(readFileSync(cache, "utf8")) : { login: "ambient-personal", id: 1 }));\n`);
    const codex = join(state, "codex-cli.mjs"); const ambientHome = join(state, "ambient-codex"); mkdirSync(ambientHome); writeFileSync(join(ambientHome, "auth.json"), JSON.stringify({ email: "personal@example.test" }));
    writeFileSync(codex, `import { readFileSync, writeFileSync } from "node:fs"; import { join } from "node:path"; import { createInterface } from "node:readline";
const auth = join(process.env.CODEX_HOME, "auth.json");
if (process.argv.includes("app-server")) {
 writeFileSync(auth, JSON.stringify({ email: "work@example.test", access_token: "owned-subscription-token" }));
 createInterface({ input: process.stdin }).on("line", line => { const m = JSON.parse(line); if (m.id === 1) process.stdout.write(JSON.stringify({ id: 1, result: {} }) + "\\n"); if (m.method === "account/read") process.stdout.write(JSON.stringify({ id: m.id, result: { account: { type: "chatgpt", email: JSON.parse(readFileSync(auth)).email } } }) + "\\n"); });
} else process.stdout.write(JSON.stringify({ email: JSON.parse(readFileSync(auth)).email, api_key_present: Boolean(process.env.OPENAI_API_KEY) }));\n`);
    const repo = join(state, "repo"); execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" }); writeFileSync(join(repo, "README.md"), "# Owned execution fixture\n");
    execFileSync("git", ["add", "."], { cwd: repo }); execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "fixture"], { cwd: repo, stdio: "ignore" });
    const ownedWorkspaces: string[] = []; let coordinatorNotes: string;
    const server = createServer({ port: 0, stateDir: state, token: "account-contract-owner", machines: false, factory: {
      accountTools: { github: { executable: process.execPath, args: [fixture, "--fixture-signin"] }, codex: { executable: process.execPath, args: [codex] } },
      native: { version: async () => "owned-native-fixture", createWorkspace: async (options) => {
        const workspace = await workspaceCreate(options); ownedWorkspaces.push(workspace.workspace.workspace_id);
        const observed = Bun.spawnSync([process.execPath, fixture, "api", "user"], { env: { ...process.env, ...options.env }, cwd: options.cwd });
        const credentials = Bun.spawnSync(["git", "credential", "fill"], { env: { ...process.env, ...options.env }, cwd: options.cwd, stdin: Buffer.from("protocol=https\nhost=github.com\n\n") });
        expect(credentials.exitCode).toBe(0);
        const subscription = Bun.spawnSync(["codex", "--fixture-agent-receipt"], { env: { ...process.env, ...options.env, CODEX_HOME: ambientHome, OPENAI_API_KEY: "owned-ambient-api-key" }, cwd: options.cwd });
        expect(subscription.exitCode).toBe(0);
        const receipt = { ...JSON.parse(observed.stdout.toString()), https_username: credentials.stdout.toString().match(/^username=(.+)$/m)?.[1], subscription: JSON.parse(subscription.stdout.toString()) };
        if (!options.label?.startsWith("saurons-eye-worker-")) coordinatorNotes = options.env!.FACTORY_NOTES_DIR!;
        writeFileSync(join(coordinatorNotes, options.label?.startsWith("saurons-eye-worker-") ? "worker-account-observed.json" : "account-observed.json"), JSON.stringify(receipt), { mode: 0o600 });
        return workspace;
      }, startAgent: async (options) => { await herdrRpc("pane.report_agent", { pane_id: options.paneId, source: "manual", agent: "codex", state: "idle" }); } },
    } }); apps.push(server); const origin = `http://localhost:${server.port}`;
    const post = async (path: string, body: unknown) => { const response = await fetch(origin + "/api/factory" + path, { method: "POST", headers, body: JSON.stringify(body) }); expect(response.ok).toBe(true); return response.json(); };
    try {
      const profile = await post("/machines/local/accounts", { name: "Execution work", service: "github", expected_login: "fictional-work" });
      await post(`/machines/local/accounts/${profile.id}/verify`, { expected_revision: profile.revision });
      const subscription = await post("/machines/local/accounts", { name: "Execution subscription", service: "codex", expected_login: "work@example.test" });
      await post(`/machines/local/accounts/${subscription.id}/verify`, { expected_revision: subscription.revision });
      const project = await post("/projects", { name: "Execution Project", path: repo, machine_id: "local", provider: "codex", tracker: "app" });
      await post(`/projects/${project.id}/configure`, { account_bindings: { local: { github: profile.id, codex: subscription.id } }, checks: [["bun", "test"]], permissions: "Owned fixtures only; no publication" });
      const idea = await post("/implementations", { title: "Account environment fixture", description: "Owned context" });
      await post(`/implementations/${idea.id}/configure`, { project_id: project.id });
      const run = await post(`/implementations/${idea.id}/runs`, { action: "setup", idempotency_key: "account-environment-fixture" });
      expect((await fetch(`${origin}/api/factory/machines/local/accounts/${profile.id}/configure`, { method: "POST", headers, body: JSON.stringify({ expected_revision: profile.revision, name: "Cannot retarget active work" }) })).status).toBe(409);
      const worker = await post(`/runs/${run.id}/workers`, { role: "standards", idempotency_key: "account-worker-inheritance" });
      expect(worker.condition).toBe("working");
      const artifacts = await post(`/runs/${run.id}/import-artifacts`, {});
      const observed = artifacts.find((entry: { name: string }) => entry.name === "account-observed.json");
      expect(observed).toBeDefined();
      const data = await (await fetch(`${origin}/api/factory/artifacts/${observed.id}/source`, { headers })).json();
      expect(data.login).toBe("fictional-work");
      expect(data.https_username).toBe("fictional-work");
      expect(data.subscription).toEqual({ email: "work@example.test", api_key_present: false });
      const workerReceipt = artifacts.find((entry: { name: string }) => entry.name === "worker-account-observed.json"); expect(workerReceipt).toBeDefined();
      expect((await (await fetch(`${origin}/api/factory/artifacts/${workerReceipt.id}/source`, { headers })).json()).https_username).toBe("fictional-work");
      expect((await fetch(`${origin}/api/factory/implementations/${idea.id}/messages`, { method: "POST", headers, body: JSON.stringify({ chat_id: "owned", content: "owned-subscription-token" }) })).status).toBe(409);
    } finally { for (const id of ownedWorkspaces) await workspaceClose(id).catch(() => {}); }
  });

  test("remote Machine setup keeps profiles and keys on that host and returns only public records", async () => {
    const hostState = mkdtempSync(join(tmpdir(), "saurons-accounts-remote-host-")); roots.push(hostState);
    const centralState = mkdtempSync(join(tmpdir(), "saurons-accounts-remote-central-")); roots.push(centralState);
    const host = createServer({ port: 0, stateDir: hostState, token: "owned-account-host", machines: false }); apps.push(host);
    const central = createServer({ port: 0, stateDir: centralState, token: "account-contract-owner", machines: false, factory: { machineEndpoint: (id) => id === "owned-remote" ? { url: `http://localhost:${host.port}`, token: "owned-account-host" } : undefined } }); apps.push(central);
    const origin = `http://localhost:${central.port}`; const route = "/api/factory/machines/owned-remote/accounts";
    const response = await fetch(origin + route, { method: "POST", headers, body: JSON.stringify({ name: "Remote GitHub", service: "github", expected_login: "fictional-remote" }) });
    expect(response.status).toBe(201); const profile = await response.json();
    const generated = await fetch(`${origin}${route}/${profile.id}/key`, { method: "POST", headers, body: JSON.stringify({ expected_revision: profile.revision }) });
    expect(generated.status).toBe(200); const key = await generated.json(); expect(key.public_key).toMatch(/^ssh-ed25519 /);
    const hostProfiles = await (await fetch(`http://localhost:${host.port}/api/factory/machines/local/accounts`, { headers: { authorization: "Bearer owned-account-host" } })).json();
    expect(hostProfiles.profiles[0].id).toBe(profile.id);
    const centralProfiles = await (await fetch(origin + "/api/factory/machines/local/accounts", { headers })).json();
    expect(centralProfiles.profiles).toEqual([]);
    expect(JSON.stringify(key)).not.toContain(hostState);
    expect(JSON.stringify(key)).not.toContain(centralState);
  });

  test("owner controls reject missing Machine headers and do not retain account storage paths in factory messages", async () => {
    const current = app();
    const unguarded = { authorization: headers.authorization, "content-type": "application/json", "x-herdr-factory": "1" };
    expect((await fetch(current.origin + "/api/factory-host/accounts/snapshot", { method: "POST", headers: unguarded, body: JSON.stringify({ bindings: {} }) })).status).toBe(403);
    const captured = await fetch(current.origin + "/api/factory/implementations", { method: "POST", headers, body: JSON.stringify({ title: "Unsafe credential fixture", text: `Read private credentials from ${join(current.state, "accounts")}` }) });
    expect(captured.status).toBe(409);
    expect((await captured.json()).error.code).toBe("account_private_material");
  });

  test("disabling a selected profile changes its revision and retains its existing public key", async () => {
    const current = app(); const route = "/api/factory/machines/local/accounts";
    let profile = await (await fetch(current.origin + route, { method: "POST", headers, body: JSON.stringify({ name: "Disable fixture", service: "github", expected_login: "fictional-disable" }) })).json();
    profile = await (await fetch(`${current.origin}${route}/${profile.id}/key`, { method: "POST", headers, body: JSON.stringify({ expected_revision: profile.revision }) })).json();
    const response = await fetch(`${current.origin}${route}/${profile.id}/disable`, { method: "POST", headers, body: JSON.stringify({ expected_revision: profile.revision }) });
    expect(response.status).toBe(200); const disabled = await response.json();
    expect(disabled.state).toBe("disabled"); expect(disabled.revision).not.toBe(profile.revision);
    expect(disabled.public_key).toBe(profile.public_key);
    expect((await fetch(`${current.origin}${route}/${profile.id}/setup`, { method: "POST", headers, body: JSON.stringify({ expected_revision: disabled.revision }) })).status).toBe(409);
  });
});
