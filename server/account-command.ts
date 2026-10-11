/** Private launcher used by a Run's PATH wrappers; never an HTTP or browser credential surface. */
import { readFileSync } from "node:fs";
import type { AccountBindingSnapshot, AccountService } from "../shared/accounts.ts";
import type { AccountTools } from "./account-tools.ts";
import { MachineAccounts } from "./accounts.ts";

if (import.meta.main) {
  let accounts: MachineAccounts | undefined;
  try {
    const path = process.argv[2]; const service = process.argv[3] as AccountService;
    if (!path || !["github", "codex", "claude", "cf", "wrangler"].includes(service)) throw new Error("Invalid launcher");
    const scope = JSON.parse(readFileSync(path, "utf8")) as { state_dir: string; snapshot: AccountBindingSnapshot; tools: AccountTools };
    accounts = new MachineAccounts(scope.state_dir, scope.tools, true);
    process.exitCode = await accounts.command(scope.snapshot, service, process.argv.slice(4));
  } catch {
    process.stderr.write("The frozen account context is unavailable or this command overrides it. Verify the Project accounts before continuing.\n");
    process.exitCode = 1;
  } finally { accounts?.stop(); }
}
