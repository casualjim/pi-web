import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { PiSessionService } from "./piSessionService.js";
import { CapturingSessionEventHub, sessionGateway } from "./piSessionService.testSupport.js";
import { resolveSessionModelOptions } from "./sessionModelScope.js";

const PROVIDER = "anthropic";
const FIRST_MODEL = "claude-opus-4-6";
const DEFAULT_MODEL = "claude-sonnet-4-5";

let modelRuntime: ModelRuntime;
const tempDirs: string[] = [];

beforeAll(async () => {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(PROVIDER, () => Promise.resolve({ type: "api_key", key: "sk-test" }));
  modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function services(settings: { enabledModels?: string[]; defaultProvider?: string; defaultModel?: string }) {
  return {
    modelRuntime,
    settingsManager: SettingsManager.inMemory(settings),
  };
}

describe("resolveSessionModelOptions", () => {
  it("preserves configured scope order and selects an in-scope saved default", async () => {
    const resolved = await resolveSessionModelOptions({
      services: services({
        enabledModels: [`${PROVIDER}/${FIRST_MODEL}:high`, `${PROVIDER}/${DEFAULT_MODEL}:low`],
        defaultProvider: PROVIDER,
        defaultModel: DEFAULT_MODEL,
      }),
      hasExistingSession: false,
    });

    expect(resolved.scopedModels.map(({ model, thinkingLevel }) => ({ id: model.id, thinkingLevel }))).toEqual([
      { id: FIRST_MODEL, thinkingLevel: "high" },
      { id: DEFAULT_MODEL, thinkingLevel: "low" },
    ]);
    expect(resolved.model?.id).toBe(DEFAULT_MODEL);
    expect(resolved.thinkingLevel).toBe("low");
    expect(resolved.diagnostics).toEqual([]);
  });

  it("uses the first scoped model and its pinned thinking when the saved default is outside scope", async () => {
    const resolved = await resolveSessionModelOptions({
      services: services({
        enabledModels: [`${PROVIDER}/${FIRST_MODEL}:high`],
        defaultProvider: PROVIDER,
        defaultModel: DEFAULT_MODEL,
      }),
      hasExistingSession: false,
    });

    expect(resolved.model?.id).toBe(FIRST_MODEL);
    expect(resolved.thinkingLevel).toBe("high");
  });

  it("keeps an explicit model and thinking level while still populating the cycle scope", async () => {
    const explicitModel = modelRuntime.getModel(PROVIDER, DEFAULT_MODEL);
    if (explicitModel === undefined) throw new Error("expected explicit model fixture");

    const resolved = await resolveSessionModelOptions({
      services: services({ enabledModels: [`${PROVIDER}/${FIRST_MODEL}:high`] }),
      hasExistingSession: false,
      initialModel: explicitModel,
      initialThinkingLevel: "minimal",
    });

    expect(resolved.model).toBe(explicitModel);
    expect(resolved.thinkingLevel).toBe("minimal");
    expect(resolved.scopedModels.map(({ model }) => model.id)).toEqual([FIRST_MODEL]);
  });

  it("leaves the initial model unset for an existing session so pi can restore it", async () => {
    const resolved = await resolveSessionModelOptions({
      services: services({ enabledModels: [`${PROVIDER}/${FIRST_MODEL}:high`] }),
      hasExistingSession: true,
    });

    expect(resolved.model).toBeUndefined();
    expect(resolved.thinkingLevel).toBeUndefined();
    expect(resolved.scopedModels.map(({ model }) => model.id)).toEqual([FIRST_MODEL]);
  });

  it("keeps an empty runtime scope when enabledModels is absent", async () => {
    await expect(resolveSessionModelOptions({
      services: services({}),
      hasExistingSession: false,
    })).resolves.toEqual({ scopedModels: [], diagnostics: [] });
  });

  it("reports unmatched patterns without blocking startup or inventing a scope", async () => {
    const resolved = await resolveSessionModelOptions({
      services: services({ enabledModels: ["anthropic/not-a-real-model"] }),
      hasExistingSession: false,
    });

    expect(resolved.scopedModels).toEqual([]);
    expect(resolved.model).toBeUndefined();
    expect(resolved.diagnostics).toEqual([{
      type: "warning",
      message: 'No models match pattern "anthropic/not-a-real-model"',
    }]);
  });

  it("keeps a matched model while surfacing an invalid pinned thinking level", async () => {
    const pattern = `${PROVIDER}/${FIRST_MODEL}:turbo`;
    const resolved = await resolveSessionModelOptions({
      services: services({ enabledModels: [pattern] }),
      hasExistingSession: false,
    });

    expect(resolved.scopedModels.map(({ model }) => model.id)).toEqual([FIRST_MODEL]);
    expect(resolved.scopedModels[0]?.thinkingLevel).toBeUndefined();
    expect(resolved.diagnostics).toEqual([{
      type: "warning",
      message: `Invalid thinking level "turbo" in pattern "${pattern}". Using default instead.`,
    }]);
  });

  it("wires project-overridden enabledModels into real PI WEB sessions", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-web-model-scope-"));
    tempDirs.push(root);
    const agentDir = join(root, "agent");
    const workspace = join(root, "workspace");
    await mkdir(join(workspace, ".pi"), { recursive: true });
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "settings.json"), JSON.stringify({
      enabledModels: [`${PROVIDER}/${FIRST_MODEL}`],
    }));
    await writeFile(join(workspace, ".pi", "settings.json"), JSON.stringify({
      enabledModels: [`${PROVIDER}/${FIRST_MODEL}:high`, `${PROVIDER}/${DEFAULT_MODEL}:low`],
      defaultProvider: PROVIDER,
      defaultModel: DEFAULT_MODEL,
    }));

    const gateway = sessionGateway([]);
    gateway.create = (cwd) => SessionManager.inMemory(cwd);
    const service = new PiSessionService(new CapturingSessionEventHub(), {
      agentDir,
      modelRuntime,
      sessionManager: gateway,
      heartbeatIntervalMs: 60_000,
    });

    try {
      const created = await service.start(workspace);
      await expect(service.availableModels({ id: created.id, cwd: workspace })).resolves.toEqual([
        expect.objectContaining({ provider: PROVIDER, id: FIRST_MODEL }),
        expect.objectContaining({ provider: PROVIDER, id: DEFAULT_MODEL }),
      ]);
      await expect(service.status({ id: created.id, cwd: workspace })).resolves.toMatchObject({
        model: { provider: PROVIDER, id: DEFAULT_MODEL },
        thinkingLevel: "low",
      });
      await expect(service.cycleModel({ id: created.id, cwd: workspace }, "forward")).resolves.toMatchObject({
        model: { provider: PROVIDER, id: FIRST_MODEL },
        thinkingLevel: "high",
      });
    } finally {
      await service.dispose();
    }
  });
});
