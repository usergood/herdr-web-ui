import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "./index.ts";

describe("Machine account profiles through the owner HTTP interface", () => {
  const roots: string[] = [];
  const apps: ReturnType<typeof createServer>[] = [];
  const headers = { authorization: "Bearer account-contract-owner", "content-type": "application/json", "x-herdr-factory": "1", "x-herdr-machine": "1" };
  function app(stateDir?: string, githubFixture?: string) {
    const state = stateDir ?? mkdtempSync(join(tmpdir(), "saurons-accounts-contract-"));
    if (!stateDir) roots.push(state);
    const server = createServer({ port: 0, stateDir: state, token: "account-contract-owner", machines: false, ...(githubFixture ? { factory: { accountTools: { github: { executable: process.execPath, args: [githubFixture] } } } } : {}) });
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
});
