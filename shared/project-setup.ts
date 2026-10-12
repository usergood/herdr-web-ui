import type { FactoryProvider } from "./factory.ts";
import type { AgentPermissionMode } from "./agent-permissions.ts";

export interface ProjectCheckChoice { id: string; name: string; args: string[] }
export interface ProjectDiscovery {
  protocol: 1; path: string; repository: string; head: string; name: string;
  checks: ProjectCheckChoice[]; guidance: string[];
  providers: { provider: FactoryProvider; installed: boolean; version: string | null }[];
  permission_modes: Record<FactoryProvider, AgentPermissionMode[]>;
  github: { repository: string | null; account_hint: string | null; directory_scoped: boolean };
  warnings: string[];
}
export const MATT_PROJECT_WORKFLOW = "Use the pinned Matt Pocock workflow. Reuse existing AGENTS.md/CLAUDE.md, glossary, ADRs and coding standards. Use setup-matt-pocock-skills for the app-native tracker and documentation layout, grill-with-docs/domain-modeling to resolve domain language with the owner, and writing-for-agents for concise coding standards and context pointers. Preserve existing documents, resolve terms before creating glossary entries, and present proposed repository changes for review. Use approved Specifications and Tickets, TDD at confirmed seams, and independent Standards and Spec reviews. Keep publication and deployment within their separately approved scope.";
