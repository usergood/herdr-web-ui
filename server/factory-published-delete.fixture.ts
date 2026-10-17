import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { factoryPublicationFixture } from "./factory-publication.fixture.ts";

/** Genuine owner HTTP workflow; only the fictional GitHub transport and native agents are owned stand-ins. */
export async function publishedDeleteFixture() {
  const token = "owned-published-delete";
  const f = await factoryPublicationFixture({ coordinatorToken: token, coordinatorNative: {
    version: async () => "owned-delete-coordinator",
    modelCatalog: async provider => ({ protocol: 1, provider, models: [{ id: "owned-delete-model", name: "Owned delete model", reasoning: [], default_reasoning: null }], problem: null }),
  } });
  const originalPath = process.env.PATH, realGit = Bun.which("git");
  if (!realGit) { await f.close(); throw new Error("Owned publication requires Git"); }
  const bare = join(f.root, "published.git"), calls = join(f.root, "transport.jsonl"), bin = join(f.root, "transport-bin");
  execFileSync(realGit, ["init", "--bare", bare], { stdio: "ignore" });
  mkdirSync(bin); writeFileSync(calls, "", { mode: 0o600 });
  const globalConfig = join(f.root, "global.gitconfig"), systemConfig = join(f.root, "system.gitconfig");
  writeFileSync(globalConfig, "", { mode: 0o600 }); writeFileSync(systemConfig, "", { mode: 0o600 });
  // Replace only the transport endpoint for this fictional URL. Actual Git performs
  // the exact URL-style refspec push, without a named remote or any tracking setup.
  writeFileSync(join(bin, "git"), `#!${process.execPath}
import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const args=process.argv.slice(2), index=args.indexOf("https://github.com/fictional/project.git");
if(index>=0&&(args.includes("push")||args.includes("ls-remote"))){appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+"\\n");args[index]=${JSON.stringify(bare)};}
const result=spawnSync(${JSON.stringify(realGit)},args,{env:{...process.env,GIT_CONFIG_GLOBAL:${JSON.stringify(globalConfig)},GIT_CONFIG_SYSTEM:${JSON.stringify(systemConfig)}},stdio:"inherit"});process.exit(result.status??1);
`, { mode: 0o700 });
  process.env.PATH = bin + ":" + (originalPath ?? "");
  let unknownPush = false;
  f.afterUpload(async () => {
    const upload = f.uploads.at(-1)!;
    execFileSync("git", ["-C", upload.cwd, "-c", "push.followTags=false", "push", "--", `https://github.com/${upload.repository}.git`, `${upload.head}:refs/heads/${upload.branch}`], { stdio: "pipe" });
    if (unknownPush) throw new Error("Owned push succeeded but its acknowledgment was lost");
  });
  return { ...f, get app() { return f.app; }, bare, token,
    transportCalls: () => readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as string[]),
    publish: async (mode: "confirmed" | "uncertain" | "push-unknown" = "confirmed") => {
      await f.verify();
      const accepted = await f.request(`/runs/${f.run.id}/accept`, { head: f.head });
      if (!accepted.ok) throw new Error(`Owned result acceptance failed: ${accepted.status} ${await accepted.text()}`);
      unknownPush = mode === "push-unknown";
      f.github({ lose_receipt: mode === "uncertain" });
      return f.request(f.route + "/publish", { head: f.head, title: "fix(factory): preserve the published branch" });
    },
    close: async () => { try { await f.close(); } finally { if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath; } },
  };
}
