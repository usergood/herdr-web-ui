import { spawn } from "node:child_process";
import { FactoryError } from "./factory-host.ts";

/** Windows needs verified process-tree ownership before factory builds can run. */
export function assertFactoryBuildPlatform(): void {
  if (process.platform === "win32") throw new FactoryError("build_contract_unverified", "This platform's owned build process contract is not verified", 409);
}

/** Bounded non-PTY commands. A live handle owns cancellation; user-supplied PIDs never do. */
export function runFactoryCommand(args: string[], cwd: string, env: Record<string, string | undefined>, signal: AbortSignal, timeout: number): Promise<{ exit_code: number; output: string; cancelled: boolean }> {
  assertFactoryBuildPlatform();
  return new Promise((resolve, reject) => {
    const child = spawn(args[0]!, args.slice(1), { cwd, env, shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let bytes = 0; const chunks: Buffer[] = []; let stopped = false; let cancelled = false;
    let shutdown: Promise<boolean> | undefined; let finishing = false;
    const kill = (signal: "SIGTERM" | "SIGKILL"): void => {
      try { if (child.pid) process.kill(-child.pid, signal); }
      catch { /* Only the subsequent empty-group observation proves shutdown. */ }
    };
    const groupLeft = (): boolean => {
      try { process.kill(-child.pid!, 0); return true; }
      catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
    };
    const gone = async (ms: number): Promise<boolean> => {
      for (const deadline = Date.now() + ms; groupLeft();) {
        if (Date.now() >= deadline) return false;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      return true;
    };
    const endGroup = async (): Promise<boolean> => {
      kill("SIGTERM");
      if (await gone(2000)) return true;
      kill("SIGKILL");
      return gone(2000);
    };
    const stop = (aborted = false): void => {
      // A reaped leader can leave executing descendants holding its pipes.
      if (stopped || finishing && !groupLeft()) return;
      stopped = true; cancelled = aborted && child.signalCode === null && (child.exitCode === null || child.exitCode === 0);
      if (child.pid) shutdown ??= endGroup();
    };
    const timer = setTimeout(() => stop(), Math.max(1, timeout));
    const data = (chunk: Buffer): void => { bytes += chunk.length; if (bytes <= 2 * 1024 * 1024) chunks.push(chunk); else stop(); };
    child.stdout?.on("data", data); child.stderr?.on("data", data);
    const abort = () => stop(true);
    signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
    const finish = async (code: number): Promise<void> => {
      if (finishing) return; finishing = true;
      // The leader's close does not prove its descendants stopped. Keep owning
      // the group through the bounded forced shutdown, even with closed pipes.
      if (child.pid) shutdown ??= endGroup();
      const confirmed = !shutdown || await shutdown;
      clearTimeout(timer); signal.removeEventListener("abort", abort);
      if (!confirmed) { reject(new Error("Owned build process group shutdown remains unconfirmed")); return; }
      resolve({ exit_code: stopped && code === 0 ? 1 : code, cancelled, output: Buffer.concat(chunks).toString("utf8") });
    };
    child.once("error", () => void finish(1)); child.once("close", code => void finish(code ?? 1));
  });
}
