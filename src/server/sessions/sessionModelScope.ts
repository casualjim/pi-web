import { modelsAreEqual } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  resolveModelScopeWithDiagnostics,
  type AgentSessionRuntimeDiagnostic,
  type ExtensionContext,
  type ModelRuntime,
  type ScopedModel,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";

type SessionModel = NonNullable<ExtensionContext["model"]>;

interface ResolveSessionModelOptionsInput {
  services: {
    modelRuntime: ModelRuntime;
    settingsManager: Pick<SettingsManager, "getDefaultModel" | "getDefaultProvider" | "getEnabledModels">;
  };
  hasExistingSession: boolean;
  initialModel?: SessionModel;
  initialThinkingLevel?: ThinkingLevel;
}

export interface ResolvedSessionModelOptions {
  scopedModels: ScopedModel[];
  diagnostics: AgentSessionRuntimeDiagnostic[];
  model?: SessionModel;
  thinkingLevel?: ThinkingLevel;
}

/** Resolve pi's cwd-bound cycling scope without overriding explicit or restored session state. */
export async function resolveSessionModelOptions(input: ResolveSessionModelOptionsInput): Promise<ResolvedSessionModelOptions> {
  const patterns = input.services.settingsManager.getEnabledModels();
  const resolved = patterns !== undefined && patterns.length > 0
    ? await resolveModelScopeWithDiagnostics(patterns, input.services.modelRuntime)
    : { scopedModels: [], diagnostics: [] };
  const diagnostics: AgentSessionRuntimeDiagnostic[] = resolved.diagnostics.map((diagnostic) => ({
    type: diagnostic.type,
    message: diagnostic.message,
  }));

  if (input.initialModel !== undefined) {
    return {
      scopedModels: resolved.scopedModels,
      diagnostics,
      model: input.initialModel,
      ...(input.initialThinkingLevel === undefined ? {} : { thinkingLevel: input.initialThinkingLevel }),
    };
  }
  if (input.hasExistingSession || resolved.scopedModels.length === 0) {
    return {
      scopedModels: resolved.scopedModels,
      diagnostics,
      ...(input.initialThinkingLevel === undefined ? {} : { thinkingLevel: input.initialThinkingLevel }),
    };
  }

  const defaultProvider = input.services.settingsManager.getDefaultProvider();
  const defaultModelId = input.services.settingsManager.getDefaultModel();
  const defaultModel = defaultProvider !== undefined && defaultModelId !== undefined
    ? input.services.modelRuntime.getModel(defaultProvider, defaultModelId)
    : undefined;
  const selected = defaultModel === undefined
    ? resolved.scopedModels[0]
    : resolved.scopedModels.find((candidate) => modelsAreEqual(candidate.model, defaultModel)) ?? resolved.scopedModels[0];
  if (selected === undefined) throw new Error("Scoped model resolution returned an empty selection");

  return {
    scopedModels: resolved.scopedModels,
    diagnostics,
    model: selected.model,
    ...(input.initialThinkingLevel !== undefined
      ? { thinkingLevel: input.initialThinkingLevel }
      : selected.thinkingLevel === undefined ? {} : { thinkingLevel: selected.thinkingLevel }),
  };
}
