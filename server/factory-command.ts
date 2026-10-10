import { spawn } from "node:child_process";

/** Bounded non-PTY commands. A live handle owns cancellation; user-supplied PIDs never do. */
export function runFactoryCommand(args: string[], cwd: string, env: Record<string, string | undefined>, signal: AbortSignal, timeout: number): Promise<{ exit_code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(args[0]!, args.slice(1), { cwd, env, shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    let bytes = 0; const chunks: Buffer[] = []; let stopped = false;
    let forced: ReturnType<typeof setTimeout> | undefined;
    const kill = (signal: "SIGTERM" | "SIGKILL"): void => {
      try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal); else child.kill(signal); }
      catch { try { child.kill(signal); } catch { /* close settles the live handle */ } }
    };
    const stop = (): void => {
      if (stopped || child.exitCode !== null || child.signalCode !== null) return;
      stopped = true;
      kill("SIGTERM"); forced = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) kill("SIGKILL"); }, 2000);
    };
    const timer = setTimeout(stop, Math.max(1, timeout));
    const data = (chunk: Buffer): void => { bytes += chunk.length; if (bytes <= 2 * 1024 * 1024) chunks.push(chunk); else stop(); };
    child.stdout?.on("data", data); child.stderr?.on("data", data);
    signal.addEventListener("abort", stop, { once: true }); if (signal.aborted) stop();
    const finish = (code: number): void => { clearTimeout(timer); clearTimeout(forced); signal.removeEventListener("abort", stop); resolve({ exit_code: stopped ? 1 : code, output: Buffer.concat(chunks).toString("utf8") }); };
    child.once("error", () => finish(1)); child.once("close", (code) => finish(code ?? 1));
  });
}
