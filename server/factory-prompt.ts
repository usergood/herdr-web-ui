import { join } from "node:path";
import { writePrivateFile } from "./factory-files.ts";

/** Herdr launch arguments cannot contain line breaks; retain the complete request as owned scaffolding. */
export function prepareFactoryPrompt(cwd: string, prompt: string, skillPrefix = ""): string {
  writePrivateFile(join(cwd, ".saurons-eye-prompt.md"), prompt);
  return `${skillPrefix ? `${skillPrefix} ` : ""}Read .saurons-eye-prompt.md for the complete initial request and follow its instructions. The file preserves the owner's idea, Project guidance and selected workflow.`;
}
