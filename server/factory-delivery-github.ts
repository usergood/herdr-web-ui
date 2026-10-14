import type { DeliveryReadRequest } from "../shared/factory-delivery.ts";
import { MachineAccounts } from "./accounts.ts";
import { FactoryError } from "./factory-host.ts";

export async function readDeliveryGitHub(accounts: MachineAccounts, request: DeliveryReadRequest): Promise<unknown> {
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(request.repository ?? "")) throw new FactoryError("invalid_delivery", "Select a GitHub repository");
  const ref = (value: unknown): string => {
    if (typeof value !== "string" || !value || value.length > 200 || /[\x00-\x20\x7f]/.test(value)) throw new FactoryError("invalid_delivery", "Select a delivery revision");
    return encodeURIComponent(value);
  };
  const number = request.number;
  if (["pull", "files"].includes(request.kind) && (!Number.isSafeInteger(number) || number! < 1)) throw new FactoryError("invalid_delivery", "Select a delivery PR");
  let path = `repos/${request.repository}`;
  switch (request.kind) {
    case "repository": break;
    case "branch": path += `/branches/${ref(request.ref)}`; break;
    case "pull": path += `/pulls/${number}`; break;
    case "files":
      if (!Number.isInteger(request.page) || request.page! < 1 || request.page! > 30) throw new FactoryError("invalid_delivery", "Select a bounded file page");
      path += `/pulls/${number}/files?per_page=100&page=${request.page}`; break;
    case "tree": path += `/git/trees/${ref(request.ref)}?recursive=1`; break;
    case "compare": path += `/compare/${ref(request.base)}...${ref(request.head)}`; break;
    default: throw new FactoryError("invalid_delivery", "Select read-only delivery evidence");
  }
  const value = await accounts.github(request.account_snapshot, ["api", path]);
  accounts.assertPublic(JSON.stringify(value));
  return value;
}
