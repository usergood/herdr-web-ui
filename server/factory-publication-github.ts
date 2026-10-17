import type { PublicationHostRequest } from "../shared/factory-publication.ts";
import type { MachineAccounts } from "./accounts.ts";
import { FactoryError } from "./factory-host.ts";

/** Exactly one repository, head branch and target; never merge/release/deploy. */
export async function publicationGitHub(accounts: MachineAccounts, request: PublicationHostRequest, push: () => Promise<void>, authorize: () => void = () => {}): Promise<unknown> {
  const p = request.publication;
  if (!p || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(p.repository) || !/^[a-f0-9]{40,64}$/.test(p.head) || ![p.branch, p.target_branch].every(ref => typeof ref === "string" && /^(?![./-])(?!.*(?:\.\.|@\{|\/\/|[\x00-\x20\x7f~^:?*\[\\]))(?!.*(?:\/$|\.$|\.lock(?:\/|$)))[^\s]+$/.test(ref) && !ref.split("/").some(part => part.startsWith("."))) || !/^[a-f0-9-]{36}$/.test(p.id)) throw new FactoryError("invalid_publication", "Select a scoped implementation publication");
  const api = (path: string, args: string[] = []) => accounts.github(p.account_snapshot, ["api", `repos/${p.repository}/${path}`, ...args], authorize);
  if (request.action === "lookup") return api(`pulls?state=all&head=${encodeURIComponent(p.repository.split("/")[0] + ":" + p.branch)}&base=${encodeURIComponent(p.target_branch)}&per_page=100&page=1`);
  if (request.action === "branch") return api(`branches/${encodeURIComponent(p.branch)}`);
  if (request.action === "push") { authorize(); await push(); return api(`branches/${encodeURIComponent(p.branch)}`); }
  if (request.action !== "create" || typeof request.title !== "string" || !request.title.trim() || request.title.length > 200) throw new FactoryError("invalid_publication", "Select scoped PR publication");
  return api("pulls", ["--method", "POST", "--raw-field", `title=${request.title}`, "--raw-field", `head=${p.branch}`, "--raw-field", `base=${p.target_branch}`, "--raw-field", `body=${p.metadata?.body ?? `Assignment ${p.implementation_id}\nReviewed head: ${p.head}\nChecks: ${p.check_id}\nIndependent reviews: ${p.review_ids.join(", ")}`}\n\n<!-- saurons-eye-pr:${p.id} -->`]);
}
