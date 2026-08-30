import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Machine, Project, Workspace } from "../api";
import { initialAppState } from "../appState";
import type { MachineNavigationSnapshot } from "../controllers/machineNavigationMemory";
import { loadExternalPlugins, type PluginManifestEntry } from "../plugins/external";
import { PluginRegistry } from "../plugins/registry";
import type { PiWebPlugin, PluginRuntimeContext, WorkspaceInvalidation, WorkspacePanelContext, WorkspacePanelNavigationV1 } from "../plugins/types";
import { PiWebApp } from "./PiWebApp";

vi.mock("../plugins/external", () => ({ loadExternalPlugins: vi.fn() }));

const project: Project = { id: "project-1", name: "Project", path: "/repo", createdAt: "now" };
const remoteMachine: Machine = { id: "remote-1", name: "Remote", kind: "remote", createdAt: "now", updatedAt: "now" };

const workspace: Workspace = {
  id: "workspace-1",
  projectId: "project-1",
  path: "/repo",
  label: "main",
  isMain: true,
  effectiveConfig: {},
};

beforeEach(() => {
  vi.mocked(loadExternalPlugins).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PiWebApp plugin host", () => {
  it("routes selected-panel, route, activity, and refresh-current invalidation through the generic seam", async () => {
    const app = createApp();
    setAppState(app, {
      ...initialAppState(),
      selectedWorkspace: workspace,
      workspaces: [workspace],
      workspaceTool: "browser-only:workspace.panel",
      mainView: "browser-only:workspace.panel",
    });
    const invalidated = vi.fn<(context: WorkspacePanelContext) => void>();
    appPluginRegistry(app).register({ id: "browser-only", plugin: pluginWithPanel("Browser only", invalidated) });

    await callAsyncAppMethod(app, "refreshCurrentWorkspaceSurface");
    await callAsyncAppMethod(app, "refreshRestoredWorkspaceTool", "browser-only:workspace.panel", undefined);
    callAppMethod(app, "refreshSelectedWorkspaceTool", "browser-only:workspace.panel");
    await Promise.resolve();

    const actions = callAppMethod(app, "getDefaultActions");
    if (!Array.isArray(actions)) throw new Error("PiWebApp default actions were unavailable");
    const refreshCurrent = actions.find((candidate): candidate is { id: string; run: () => void | Promise<void> } => isAction(candidate) && candidate.id === "core:workspace.refresh-current");
    await refreshCurrent?.run();

    const inactive = { ...initialAppState(), selectedWorkspace: workspace, workspaces: [workspace], workspaceTool: "browser-only:workspace.panel" as const };
    const active = { ...inactive, activity: { sessionId: "session-1", phase: "active" as const, label: "working", at: "now" } };
    setAppState(app, inactive);
    callAppMethod(app, "handleActivityTransition", active, inactive);
    await Promise.resolve();

    expect(invalidated).toHaveBeenCalledTimes(5);
  });

  it("keeps legacy refreshFiles behavior through scoped workspace.files invalidation", async () => {
    const app = createApp();
    setAppState(app, {
      ...initialAppState(),
      selectedWorkspace: workspace,
      workspaces: [workspace],
      workspaceTool: "core:workspace.files",
    });
    const subscribed = vi.fn<(context: WorkspacePanelContext, invalidation?: WorkspaceInvalidation) => void>();
    const legacy = vi.fn();
    appPluginRegistry(app).register({
      id: "browser-only",
      plugin: {
        apiVersion: 2,
        name: "Browser only",
        activate: ({ html }) => ({
          contributions: {
            workspacePanels: [
              { id: "resource", title: "Resource", invalidationResources: ["workspace.files"], onInvalidate: subscribed, render: () => html`<p>Resource</p>` },
              { id: "legacy", title: "Legacy", onInvalidate: legacy, render: () => html`<p>Legacy</p>` },
            ],
          },
        }),
      },
    });
    const filesController: unknown = Reflect.get(app, "files");
    if (typeof filesController !== "object" || filesController === null) throw new Error("PiWebApp files controller was unavailable");
    let finishCoreRefresh: () => void = () => undefined;
    const coreRefresh = new Promise<void>((resolve) => { finishCoreRefresh = resolve; });
    const refreshCoreFiles = vi.fn(() => coreRefresh);
    if (!Reflect.set(filesController, "refreshFiles", refreshCoreFiles)) throw new Error("Could not stub core Files refresh");

    const runtime = createPluginRuntimeContext(app);
    const refreshFiles: unknown = Reflect.get(runtime, "refreshFiles");
    if (!isAsyncVoidCallback(refreshFiles)) throw new Error("Legacy refreshFiles runtime alias was unavailable");
    let aliasSettled = false;
    const aliasCompletion = Promise.resolve(refreshFiles()).then(() => { aliasSettled = true; });
    await Promise.resolve();

    expect(refreshCoreFiles).toHaveBeenCalledOnce();
    expect(aliasSettled).toBe(false);
    finishCoreRefresh();
    await aliasCompletion;
    expect(aliasSettled).toBe(true);
    expect(subscribed).toHaveBeenCalledOnce();
    const call = subscribed.mock.calls[0];
    expect(call?.[0].machine.id).toBe("local");
    expect(call?.[0].workspace.id).toBe("workspace-1");
    expect(call?.[1]).toEqual({ reason: "manual", resources: ["workspace.files"] });
    expect(legacy).not.toHaveBeenCalled();
  });

  it("binds panel navigation snapshots and writes to the selected machine/workspace only", () => {
    const browser = installBrowserWindow("http://localhost/app?machine=remote-1&project=project-1&workspace=workspace-1&browser-only.workspace.panel--file=canonical.ts&legacy.workspace.panel--file=legacy.ts&legacy.workspace.panel--mode=preview");
    const app = new PiWebApp();
    setAppState(app, {
      ...initialAppState(),
      selectedMachine: remoteMachine,
      selectedProject: project,
      selectedWorkspace: workspace,
      workspaces: [workspace],
      workspaceTool: "browser-only:workspace.panel",
      mainView: "browser-only:workspace.panel",
    });
    let navigation: WorkspacePanelNavigationV1 | undefined;
    appPluginRegistry(app).register({
      id: "browser-only",
      plugin: {
        apiVersion: 2,
        name: "Browser only",
        activate: ({ html }) => ({
          contributions: {
            workspacePanels: [{
              id: "workspace.panel",
              title: "Panel",
              navigationAliases: ["legacy:workspace.panel"],
              render: (context) => {
                navigation = context.navigation;
                return html`<p>Panel</p>`;
              },
            }],
          },
        }),
      },
    });
    const panel = appPluginRegistry(app).getWorkspacePanels().find(({ id }) => id === "browser-only:workspace.panel");
    const context = workspacePanelContextFromApp(app);

    panel?.render(context);

    expect(navigation).toMatchObject({
      version: 1,
      contributionId: "browser-only:workspace.panel",
      query: { file: "canonical.ts", mode: "preview" },
    });
    const firstSnapshot = navigation;
    firstSnapshot?.set("file", "src/main.ts");
    expect(browser.pushed).toHaveLength(1);
    expect(browser.url.searchParams.get("browser-only.workspace.panel--file")).toBe("src/main.ts");
    expect(browser.url.searchParams.has("legacy.workspace.panel--file")).toBe(false);
    expect(machineNavigationSnapshot(app, "remote-1")?.surface.contributionQuery).toMatchObject({
      "browser-only.workspace.panel--file": "src/main.ts",
      "legacy.workspace.panel--mode": "preview",
    });

    browser.navigate("http://localhost/app?machine=remote-1&project=project-1&workspace=workspace-1&browser-only.workspace.panel--file=back.ts");
    panel?.render(workspacePanelContextFromApp(app));
    expect(navigation?.query).toEqual({ file: "back.ts" });
    expect(firstSnapshot?.query).toEqual({ file: "canonical.ts", mode: "preview" });

    browser.navigate("http://localhost/app?machine=other&project=project-1&workspace=workspace-1&browser-only.workspace.panel--file=other.ts");
    panel?.render(workspacePanelContextFromApp(app));
    expect(navigation?.query).toEqual({});
    const writesBeforeStaleSet = browser.pushed.length;
    firstSnapshot?.set("mode", "raw");
    expect(browser.pushed).toHaveLength(writesBeforeStaleSet);
    expect(browser.url.searchParams.get("browser-only.workspace.panel--mode")).toBeNull();
  });

  it("falls back to the first visible panel and keeps Chat available when a requested panel is unavailable", async () => {
    const browser = installBrowserWindow("http://localhost/app?project=project-1&workspace=workspace-1&tool=core%3Aworkspace.files&view=core%3Aworkspace.files");
    const app = new PiWebApp();
    setAppState(app, {
      ...initialAppState(),
      selectedProject: project,
      selectedWorkspace: workspace,
      workspaces: [workspace],
      workspaceTool: "core:workspace.files",
      mainView: "core:workspace.files",
    });
    const filesPanel = appPluginRegistry(app).getWorkspacePanels().find(({ id }) => id === "core:workspace.files");
    if (filesPanel === undefined) throw new Error("Core Files panel was unavailable");
    filesPanel.visible = () => false;

    await callAsyncAppMethod(app, "finishWorkspaceRouteRestore", undefined, { contributionQuery: {} }, {
      updateUrl: false,
      normalizeUnavailableRoute: false,
      unavailablePanelViewRoute: false,
      requestedTool: "core:workspace.files",
      requestedView: "core:workspace.files",
    });

    expect(appState(app)).toMatchObject({
      workspaceTool: "core:workspace.terminal",
      mainView: "core:workspace.terminal",
    });
    expect(browser.url.searchParams.get("tool")).toBe("core:workspace.terminal");
    expect(browser.url.searchParams.get("view")).toBe("core:workspace.terminal");
    expect(mobileTabIds(app)).toEqual(["navigation", "chat", "core:workspace.terminal"]);

    setAppState(app, {
      ...appState(app),
      workspaceTool: "missing:workspace.panel",
      mainView: "chat",
    });
    callAppMethod(app, "reconcileWorkspacePanelSelection");

    expect(appState(app).workspaceTool).toBe("core:workspace.terminal");
    expect(appState(app).mainView).toBe("chat");
  });

  it("replaces an unresolved panel deep link after plugin loading completes", async () => {
    const browser = installBrowserWindow("http://localhost/app?project=project-1&workspace=workspace-1&tool=missing&view=missing");
    const app = new PiWebApp();
    setAppState(app, {
      ...initialAppState(),
      selectedProject: project,
      selectedWorkspace: workspace,
      workspaces: [workspace],
      workspaceTool: "core:workspace.terminal",
      mainView: "chat",
    });
    if (!Reflect.set(app, "gatewayPluginLoadPromise", Promise.resolve())) throw new Error("Could not mark gateway plugins loaded");

    await callAsyncAppMethod(app, "restoreRouteFor", {
      machineId: undefined,
      projectId: "project-1",
      workspaceId: "workspace-1",
      sessionId: undefined,
      tool: "missing",
      view: "missing",
    }, false, { contributionQuery: {} });

    expect(appState(app)).toMatchObject({
      workspaceTool: "core:workspace.terminal",
      mainView: "core:workspace.terminal",
    });
    expect(browser.url.searchParams.get("tool")).toBe("core:workspace.terminal");
    expect(browser.url.searchParams.get("view")).toBe("core:workspace.terminal");
    expect(browser.replaced.length).toBeGreaterThan(0);
  });

  it("keeps successful registrations while making an incomplete gateway load retryable", async () => {
    const app = createApp();
    stubPluginLoadRendering(app);
    const stableEntry = manifestEntry("stable");
    const retryEntry = manifestEntry("retry");
    const transientFailure = new Error("temporary module failure");
    let attempt = 0;
    vi.mocked(loadExternalPlugins).mockImplementation((_manifestUrl, options = {}) => {
      attempt += 1;
      if (attempt === 1) {
        return Promise.resolve({
          registrations: [{ id: "stable", machineSpecific: false, plugin: emptyPlugin("Stable") }],
          failures: [{ entry: retryEntry, error: transientFailure }],
        });
      }
      expect(options.shouldLoadPlugin?.(stableEntry)).toBe(false);
      return Promise.resolve({
        registrations: [{ id: "retry", machineSpecific: false, plugin: emptyPlugin("Retry") }],
        failures: [],
      });
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await ensureGatewayPluginsLoaded(app);

    expect(appPluginRegistry(app).hasPlugin("stable")).toBe(true);
    expect(appPluginRegistry(app).hasPlugin("retry")).toBe(false);
    expect(Reflect.get(app, "gatewayPluginLoadPromise")).toBeUndefined();

    await ensureGatewayPluginsLoaded(app);

    expect(loadExternalPlugins).toHaveBeenCalledTimes(2);
    expect(appPluginRegistry(app).hasPlugin("stable")).toBe(true);
    expect(appPluginRegistry(app).hasPlugin("retry")).toBe(true);
    expect(warning).toHaveBeenCalledWith(
      "Failed to load PI WEB plugin retry (./retry/plugin.js)",
      transientFailure,
    );
  });

  it("retries a plugin whose activation failed without retaining partial contributions", async () => {
    const app = createApp();
    stubPluginLoadRendering(app);
    let activationAttempts = 0;
    const retryable: PiWebPlugin = {
      apiVersion: 2,
      name: "Retryable",
      activate: () => {
        activationAttempts += 1;
        if (activationAttempts === 1) {
          return {
            contributions: {
              actions: [
                { id: "action", title: "Partial", run: () => undefined },
                { id: "action", title: "Duplicate", run: () => undefined },
              ],
            },
          };
        }
        return { contributions: { actions: [{ id: "action", title: "Ready", run: () => undefined }] } };
      },
    };
    vi.mocked(loadExternalPlugins).mockResolvedValue({
      registrations: [{ id: "retryable", machineSpecific: false, plugin: retryable }],
      failures: [],
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await ensureGatewayPluginsLoaded(app);
    expect(appPluginRegistry(app).hasPlugin("retryable")).toBe(false);
    expect(Reflect.get(app, "gatewayPluginLoadPromise")).toBeUndefined();

    await ensureGatewayPluginsLoaded(app);

    expect(activationAttempts).toBe(2);
    expect(appPluginRegistry(app).hasPlugin("retryable")).toBe(true);
    expect(appPluginRegistry(app).getActions(createPluginRuntimeContext(app)).filter(({ pluginId }) => pluginId === "retryable").map(({ title }) => title)).toEqual(["Ready"]);
  });
});

function createApp(): PiWebApp {
  installBrowserWindow("http://localhost/app");
  return new PiWebApp();
}

function installBrowserWindow(href: string): {
  readonly url: URL;
  readonly pushed: string[];
  readonly replaced: string[];
  navigate(next: string): void;
} {
  let current = new URL(href);
  const pushed: string[] = [];
  const replaced: string[] = [];
  const storage = {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  };
  const location = {
    get href() { return current.href; },
    get pathname() { return current.pathname; },
    get search() { return current.search; },
    get hash() { return current.hash; },
  };
  const commit = (target: URL | string, entries: string[]) => {
    current = new URL(String(target), current);
    entries.push(current.href);
  };
  vi.stubGlobal("window", {
    location,
    localStorage: storage,
    history: {
      pushState: vi.fn((_state: object, _title: string, next: URL | string) => { commit(next, pushed); }),
      replaceState: vi.fn((_state: object, _title: string, next: URL | string) => { commit(next, replaced); }),
    },
  });
  return {
    get url() { return current; },
    pushed,
    replaced,
    navigate: (next) => { current = new URL(next, current); },
  };
}

function setAppState(app: PiWebApp, state: ReturnType<typeof initialAppState>): void {
  if (!Reflect.set(app, "state", state)) throw new Error("Could not set PiWebApp state");
}

function appState(app: PiWebApp): ReturnType<typeof initialAppState> {
  const state: unknown = Reflect.get(app, "state");
  if (!isAppState(state)) throw new Error("PiWebApp state was unavailable");
  return state;
}

function workspacePanelContextFromApp(app: PiWebApp): WorkspacePanelContext {
  const createContext: unknown = Reflect.get(app, "createWorkspacePanelContext");
  if (typeof createContext !== "function") throw new Error("PiWebApp workspace-panel context factory was unavailable");
  const context: unknown = Reflect.apply(createContext, app, [workspace]);
  if (!isWorkspacePanelContext(context)) throw new Error("PiWebApp workspace-panel context was invalid");
  return context;
}

function machineNavigationSnapshot(app: PiWebApp, machineId: string): MachineNavigationSnapshot | undefined {
  const memory: unknown = Reflect.get(app, "machineNavigation");
  if (typeof memory !== "object" || memory === null) throw new Error("PiWebApp machine-navigation memory was unavailable");
  const latest: unknown = Reflect.get(memory, "latest");
  if (typeof latest !== "function") throw new Error("PiWebApp machine-navigation latest lookup was unavailable");
  const snapshot: unknown = Reflect.apply(latest, memory, [machineId]);
  if (snapshot === undefined) return undefined;
  if (!isMachineNavigationSnapshot(snapshot)) throw new Error("PiWebApp machine-navigation snapshot was invalid");
  return snapshot;
}

function isAppState(value: unknown): value is ReturnType<typeof initialAppState> {
  return typeof value === "object" && value !== null && "mainView" in value && "workspaceTool" in value;
}

function isWorkspacePanelContext(value: unknown): value is WorkspacePanelContext {
  return typeof value === "object" && value !== null && "workspace" in value && "machine" in value && "files" in value;
}

function isMachineNavigationSnapshot(value: unknown): value is MachineNavigationSnapshot {
  return typeof value === "object" && value !== null && "machineId" in value && "surface" in value;
}

function mobileTabIds(app: PiWebApp): string[] {
  const tabs = callAppMethod(app, "mobileMainTabs");
  if (!Array.isArray(tabs)) throw new Error("PiWebApp mobile tabs were unavailable");
  return tabs.map((tab: unknown) => {
    if (typeof tab !== "object" || tab === null || !("id" in tab) || typeof tab.id !== "string") throw new Error("PiWebApp mobile tab was invalid");
    return tab.id;
  });
}

function appPluginRegistry(app: PiWebApp): PluginRegistry {
  const registry: unknown = Reflect.get(app, "plugins");
  if (!(registry instanceof PluginRegistry)) throw new Error("PiWebApp PluginRegistry was unavailable");
  return registry;
}

function createPluginRuntimeContext(app: PiWebApp): PluginRuntimeContext {
  const createContext: unknown = Reflect.get(app, "createPluginRuntimeContext");
  if (typeof createContext !== "function") throw new Error("PiWebApp plugin runtime context factory was unavailable");
  const context: unknown = Reflect.apply(createContext, app, []);
  if (!isPluginRuntimeContext(context)) throw new Error("PiWebApp returned an invalid plugin runtime context");
  return context;
}

async function ensureGatewayPluginsLoaded(app: PiWebApp): Promise<void> {
  const ensure: unknown = Reflect.get(app, "ensureGatewayPluginsLoaded");
  if (typeof ensure !== "function") throw new Error("PiWebApp gateway plugin loader was unavailable");
  const result: unknown = Reflect.apply(ensure, app, []);
  if (!(result instanceof Promise)) throw new Error("PiWebApp gateway plugin loader did not return a promise");
  await result;
}

function isAsyncVoidCallback(value: unknown): value is () => void | Promise<void> {
  return typeof value === "function";
}

function isPluginRuntimeContext(value: unknown): value is PluginRuntimeContext {
  if (typeof value !== "object" || value === null) return false;
  return "refreshWorkspacePanels" in value && typeof value.refreshWorkspacePanels === "function";
}

function stubPluginLoadRendering(app: PiWebApp): void {
  if (!Reflect.set(app, "applyPreferredTheme", () => undefined)) throw new Error("Could not stub theme application");
  if (!Reflect.set(app, "requestUpdate", () => undefined)) throw new Error("Could not stub Lit update scheduling");
}

function pluginWithPanel(name: string, onInvalidate: (context: WorkspacePanelContext) => void): PiWebPlugin {
  return {
    apiVersion: 2,
    name,
    activate: ({ html }) => ({
      contributions: {
        workspacePanels: [{ id: "workspace.panel", title: name, onInvalidate, render: () => html`<p>${name}</p>` }],
      },
    }),
  };
}

function emptyPlugin(name: string): PiWebPlugin {
  return { apiVersion: 2, name, activate: () => ({ contributions: {} }) };
}

function callAppMethod(app: PiWebApp, name: string, ...args: unknown[]): unknown {
  const method: unknown = Reflect.get(app, name);
  if (typeof method !== "function") throw new Error(`PiWebApp.${name} is not callable`);
  return Reflect.apply(method, app, args);
}

async function callAsyncAppMethod(app: PiWebApp, name: string, ...args: unknown[]): Promise<void> {
  await callAppMethod(app, name, ...args);
}

function isAction(value: unknown): value is { id: string; run: () => void | Promise<void> } {
  return typeof value === "object" && value !== null && "id" in value && typeof value.id === "string" && "run" in value && typeof value.run === "function";
}

function manifestEntry(id: string): PluginManifestEntry {
  return { id, module: `./${id}/plugin.js`, machineSpecific: false };
}
