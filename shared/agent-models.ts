import type { FactoryProvider } from "./factory.ts";

export interface AgentModelSelection { model: string | null; reasoning: string | null }
export interface AgentModelChoice {
  id: string; name: string;
  reasoning: { id: string; name: string }[];
  default_reasoning: string | null;
}
export interface AgentModelCatalog {
  protocol: 1; provider: FactoryProvider; models: AgentModelChoice[];
  problem: string | null;
  reasoning_format?: "agent_config" | "model_suffix";
}
export interface AgentExecutionPreset extends AgentModelSelection { reasoning_format?: AgentModelCatalog["reasoning_format"] }
