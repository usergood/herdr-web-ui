/** Git's SSH hook resolves existing host aliases while selecting only the frozen account key. */
import { readFileSync } from "node:fs";
import type { AccountBindingSnapshot } from "../shared/accounts.ts";
import type { AccountTools } from "./account-tools.ts";
import { MachineAccounts } from "./accounts.ts";

if (import.meta.main) {
  let accounts: MachineAccounts | undefined;
  try {
    const path = process.argv[2]; if (!path) throw new Error("Missing scope");
    const scope = JSON.parse(readFileSync(path, "utf8")) as { state_dir: string; snapshot: AccountBindingSnapshot; tools: AccountTools };
    accounts = new MachineAccounts(scope.state_dir, scope.tools, true);
    process.exitCode = await accounts.ssh(scope.snapshot, process.argv.slice(3));
  } catch { process.stderr.write("The frozen GitHub SSH account or destination is unavailable. Verify the Project profile before continuing.\n"); process.exitCode = 1; }
  finally { accounts?.stop(); }
}
