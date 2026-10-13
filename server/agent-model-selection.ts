import type { AgentExecutionPreset, AgentModelCatalog, AgentModelSelection } from "../shared/agent-models.ts";
import { FactoryError } from "./factory-host.ts";

export function parseModelSelection(value: unknown): AgentModelSelection {
  if (value === undefined || value === null) return { model: null, reasoning: null };
  if (typeof value !== "object" || Array.isArray(value)) throw new FactoryError("invalid_model_selection", "Choose a model and its supported reasoning level");
  const selection = value as Record<string, unknown>;
  if (Object.keys(selection).some(key => !["model", "reasoning"].includes(key))) throw new FactoryError("invalid_model_selection", "Choose a model and its supported reasoning level");
  const model = selection.model ?? null, reasoning = selection.reasoning ?? null;
  const valid = (entry: unknown) => entry === null || typeof entry === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:/@+\[\]-]{0,199}$/.test(entry);
  if (!valid(model) || !valid(reasoning) || model === null && reasoning !== null) throw new FactoryError("invalid_model_selection", "Choose a model before selecting its reasoning level");
  return { model: model as string | null, reasoning: reasoning as string | null };
}

export function resolveModelSelection(selection: AgentModelSelection, catalog: AgentModelCatalog): AgentExecutionPreset {
  if (!selection.model) return selection;
  const model = catalog.models.find(entry => entry.id === selection.model);
  if (!model || catalog.problem) throw new FactoryError("model_unavailable", "The selected model is unavailable on this Machine and account. Refresh the model list and choose explicitly", 409);
  const reasoning = selection.reasoning ?? model.default_reasoning;
  if (reasoning && !model.reasoning.some(entry => entry.id === reasoning)) throw new FactoryError("reasoning_unavailable", "This model does not support the selected reasoning level. Choose from its current options", 409);
  return { model: model.id, reasoning, ...(catalog.reasoning_format ? { reasoning_format: catalog.reasoning_format } : {}) };
}
