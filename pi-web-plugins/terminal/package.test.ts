import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildTerminalPackage } from "../../scripts/build-plugins.mjs";
import { PiWebPluginCatalog } from "../../src/server/piWebPluginCatalog.js";
import { PiWebPluginService } from "../../src/server/piWebPluginService.js";
import { createServerPluginRuntime } from "../../src/server/plugins/serverPluginRuntime.js";
import { createWorkspaceProviderRuntimeSnapshot } from "../../src/server/workspaces/workspaceCatalog.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("bundled Terminal package", () => {
  it("declares one required-shaped machine-specific dual entry", async () => {
    const metadata: unknown = JSON.parse(await readFile("pi-web-plugins/terminal/package.json", "utf8"));

    expect(metadata).toMatchObject({
      private: true,
      type: "module",
      piWeb: {
        plugins: [{
          id: "terminal",
          browserRoot: "browser",
          module: "browser/pi-web-plugin.js",
          serverModule: "server-plugin.js",
          machineSpecific: true,
        }],
      },
    });
  });

  it("keeps PTY and TerminalService implementation ownership out of core production code", async () => {
    const productionFiles = (await readdir("src/server", { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts"));
    const violations: string[] = [];
    for (const entry of productionFiles) {
      const file = join(entry.parentPath, entry.name);
      const source = await readFile(file, "utf8");
      if (source.includes('from "node-pty"') || /class\s+TerminalService\b/u.test(source)) violations.push(file);
    }

    expect(violations).toEqual([]);
  });

  it("builds a package-complete self-contained browser graph and importable server graph", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-web-terminal-package-"));
    tempRoots.push(root);
    const packageRoot = join(root, "plugins", "terminal");
    await buildTerminalPackage(resolve("pi-web-plugins/terminal"), packageRoot);

    const files = (await readdir(packageRoot, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name).slice(packageRoot.length + 1))
      .sort();
    expect(files).toEqual([
      "browser/pi-web-plugin.js",
      "package.json",
      "server-plugin.js",
      "terminalService.js",
    ]);
    const browserSource = await readFile(join(packageRoot, "browser", "pi-web-plugin.js"), "utf8");
    expect(browserSource).not.toMatch(/(?:from\s*["']|import\s*\()[^"']*(?:@jmfederico\/pi-web|src\/)/u);
    expect(browserSource).not.toMatch(/sourceMappingURL/u);
    const serverSource = await readFile(join(packageRoot, "server-plugin.js"), "utf8");
    expect(serverSource).toContain('from "./terminalService.js"');
    expect(serverSource).not.toContain("src/server");

    const catalog = new PiWebPluginCatalog({
      roots: [{ path: join(root, "plugins"), source: "bundled", scope: "bundled" }],
      packageProvider: false,
      configProvider: () => ({}),
    });
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const runtime = await createServerPluginRuntime({
      catalog,
      logger,
      importer: async (moduleUrl) => {
        const imported: unknown = await import(moduleUrl);
        return imported;
      },
    });
    try {
      const health = await runtime.inspectHealth();
      const snapshot = createWorkspaceProviderRuntimeSnapshot(
        runtime.healthRecords(),
        health,
        runtime.safeStartLevel(),
        runtime.catalogDiagnostics(),
      );
      const service = new PiWebPluginService({
        catalog,
        runtimeProvider: { providerRuntime: () => Promise.resolve(snapshot) },
      });

      expect(runtime.requiredTerminalService()).toBeDefined();
      await expect(service.manifest()).resolves.toMatchObject({
        lifecycleVersion: 2,
        terminalMode: "required",
        plugins: [{
          id: "terminal",
          backendCapabilityVersion: 1,
          channelVersion: 1,
          source: "bundled",
          scope: "bundled",
          machineSpecific: true,
        }],
      });
      const serverModule = (await catalog.snapshot()).plugins[0]?.serverModule;
      expect(serverModule === undefined ? undefined : pathToFileURL(serverModule.filePath).protocol).toBe("file:");
    } finally {
      await runtime.stop();
    }
  });
});
