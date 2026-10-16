import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { factoryPublicationFixture } from "./factory-publication.fixture.ts";

/** The native writer encounters a real conflict only in its disposable, owned workspace. */
export async function upstreamConflictFixture() {
  const f = await factoryPublicationFixture({ upstream: true, deferPreparation: true });
  const path = f.run.worktree!;
  const commit = (message: string) => f.git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", message], path);
  writeFileSync(join(path, "feature.md"), "Keep the fork behavior\n");
  f.git(["add", "feature.md"], path); commit("fork behavior");
  let conflicted = false;
  try { f.git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "merge", "--no-edit", f.upstreamRevision!], path); }
  catch { conflicted = f.git(["diff", "--name-only", "--diff-filter=U"], path).trim() === "feature.md"; }
  if (!conflicted) { await f.close(); throw new Error("The owned upstream fixture did not encounter its expected conflict"); }
  const question = await f.agent("question", { question: "Upstream v1 conflicts with the fork in feature.md. Keep the fork behavior while incorporating this release?" }).then(r => r.json());
  const resolve = () => {
    writeFileSync(join(path, "feature.md"), "Keep the fork behavior\n");
    f.git(["add", "feature.md"], path); commit("resolve approved upstream conflict");
    const head = f.git(["rev-parse", "HEAD"], path).trim(); f.setReviewHead(head); return head;
  };
  return { ...f, get app() { return f.app; }, question, resolve };
}
