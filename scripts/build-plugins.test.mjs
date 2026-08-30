import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Window } from "happy-dom";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PI_WEB_PLUGIN_ARTIFACT_MAX_BYTES,
  PI_WEB_PLUGIN_ARTIFACT_MAX_ENTRIES,
  PiWebPluginCatalog,
  readPiWebPluginPackageArtifact,
} from "../src/server/piWebPluginCatalog.js";
import {
  buildDirectory,
  buildFilesBrowserPackage,
  filesBrowserBuildConfig,
  findWatchDirs,
} from "./build-plugins.mjs";

let tempDir;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "pi-web-build-plugins-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("buildDirectory", () => {
  it("materializes a symlinked file as a real file", async () => {
    const source = join(tempDir, "source");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "target.txt"), "linked content");
    await symlink(join(source, "target.txt"), join(source, "link.txt"));

    const target = join(tempDir, "out");
    await buildDirectory(source, target);

    await expect(readFile(join(target, "link.txt"), "utf8")).resolves.toBe("linked content");
    expect((await lstat(join(target, "link.txt"))).isSymbolicLink()).toBe(false);
  });

  it("materializes a symlinked directory as a real directory tree", async () => {
    const linkedDir = join(tempDir, "external-dir");
    await mkdir(linkedDir, { recursive: true });
    await writeFile(join(linkedDir, "nested.txt"), "nested content");

    const source = join(tempDir, "source");
    await mkdir(source, { recursive: true });
    await symlink(linkedDir, join(source, "link-dir"));

    const target = join(tempDir, "out");
    await buildDirectory(source, target);

    await expect(readFile(join(target, "link-dir", "nested.txt"), "utf8")).resolves.toBe("nested content");
    expect((await lstat(join(target, "link-dir"))).isSymbolicLink()).toBe(false);
  });

  it("fails the build on a broken symlink instead of silently dropping it", async () => {
    const source = join(tempDir, "source");
    await mkdir(source, { recursive: true });
    await symlink(join(tempDir, "does-not-exist.txt"), join(source, "broken.txt"));

    await expect(buildDirectory(source, join(tempDir, "out"))).rejects.toThrow();
  });

  it("guards against a symlinked directory cycling back into an ancestor", async () => {
    const source = join(tempDir, "source");
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "marker.txt"), "marker content");
    // A directory symlinking into itself (or any ancestor) previously made
    // buildDirectory recurse on an ever-lengthening synthetic path
    // (source/self/self/self/...) with no termination condition.
    await symlink(source, join(source, "self"));

    const target = join(tempDir, "out");
    await expect(buildDirectory(source, target)).resolves.toEqual({ copied: 1, transpiled: 0 });

    expect(await readdir(target)).toEqual(["marker.txt"]);
  });
});

describe("Files browser package build", () => {
  it("uses a fixed relative ES bundle layout without source maps", () => {
    const source = resolve("pi-web-plugins/files");
    const target = join(tempDir, "files");

    expect(filesBrowserBuildConfig(source, target)).toMatchObject({
      configFile: false,
      root: source,
      base: "./",
      publicDir: false,
      build: {
        outDir: join(target, "browser"),
        emptyOutDir: true,
        copyPublicDir: false,
        target: "es2022",
        minify: true,
        cssMinify: true,
        sourcemap: false,
        assetsInlineLimit: 0,
        rollupOptions: {
          input: join(source, "pi-web-plugin.ts"),
          preserveEntrySignatures: "strict",
          output: {
            format: "es",
            entryFileNames: "pi-web-plugin.js",
            chunkFileNames: "assets/[name]-[hash].js",
            assetFileNames: "assets/[name]-[hash][extname]",
          },
        },
      },
    });
  });

  it("emits only package metadata and a self-contained lazy browser graph within catalog bounds", { timeout: 30_000 }, async () => {
    const source = resolve("pi-web-plugins/files");
    const target = join(tempDir, "files");
    await buildFilesBrowserPackage(source, target);

    const packageFiles = await recursiveFiles(target);
    expect(packageFiles.filter((path) => !path.startsWith("browser/"))).toEqual(["package.json"]);
    expect(packageFiles).toContain("browser/pi-web-plugin.js");
    expect(packageFiles.some((path) => /^browser\/assets\/viewerDependencies-[^/]+\.js$/u.test(path))).toBe(true);
    expect(packageFiles.some((path) => /^browser\/assets\/files-icon-[^/]+\.svg$/u.test(path))).toBe(true);
    expect(packageFiles.some((path) => path.endsWith(".map"))).toBe(false);
    expect(packageFiles.some((path) => /\.(?:ts|css)$/u.test(path))).toBe(false);

    const metadata = JSON.parse(await readFile(join(target, "package.json"), "utf8"));
    expect(metadata).toMatchObject({
      private: true,
      type: "module",
      piWeb: {
        plugins: [{
          id: "files",
          browserRoot: "browser",
          module: "browser/pi-web-plugin.js",
          machineSpecific: false,
        }],
      },
    });

    const browserRoot = join(target, "browser");
    const browserJavaScript = packageFiles.filter((path) => path.startsWith("browser/") && path.endsWith(".js"));
    expect(browserJavaScript.length).toBeGreaterThan(1);
    for (const packagePath of browserJavaScript) {
      const file = join(target, packagePath);
      const sourceText = await readFile(file, "utf8");
      expect(sourceText).not.toMatch(/@jmfederico\/pi-web|src\/client\/src|(?:\.\.\/)+src\//u);
      for (const specifier of moduleSpecifiers(sourceText)) {
        expect(specifier, `${packagePath} contains a bare or absolute runtime import`).toMatch(/^\.\.?\//u);
        const dependency = resolve(dirname(file), specifier);
        expect(dependency === browserRoot || dependency.startsWith(`${browserRoot}${sep}`)).toBe(true);
        expect((await stat(dependency)).isFile()).toBe(true);
      }
    }

    const entryPath = join(browserRoot, "pi-web-plugin.js");
    const entrySource = await readFile(entryPath, "utf8");
    expect(moduleSpecifiers(entrySource).some((specifier) => /^\.\/assets\/viewerDependencies-[^/]+\.js$/u.test(specifier))).toBe(true);

    const moduleUrl = pathToFileURL(entryPath);
    moduleUrl.searchParams.set("buildTest", String(Date.now()));
    const { builtModule, activation } = await withBrowserGlobals(async () => {
      const imported = await import(moduleUrl.href);
      const template = (strings, ...values) => ({ strings, values });
      const activated = imported.default.activate({
        apiVersion: 2,
        pluginId: "files",
        runtimePluginId: "files",
        html: template,
        svg: template,
      });
      return { builtModule: imported, activation: activated };
    });
    expect(builtModule.default).toMatchObject({ apiVersion: 2, name: "Files" });
    expect(activation.contributions.workspacePanels).toMatchObject([{
      id: "workspace.files",
      routeAliases: ["files", "core:workspace.files"],
      navigationAliases: ["core:workspace.files"],
      invalidationResources: ["workspace.files"],
    }]);
    expect(activation.contributions.actions.map(({ id }) => id)).toEqual(["view.files", "workspace.refresh-files"]);
    expect(typeof builtModule.loadFilesViewerDependencies).toBe("function");
    expect(typeof builtModule.filesStyles).toBe("string");
    expect(builtModule.filesStyles).toContain("var(--pi-text)");
    expect(typeof builtModule.filesIconUrl).toBe("string");
    expect((await stat(fileURLToPath(builtModule.filesIconUrl))).isFile()).toBe(true);

    const catalog = new PiWebPluginCatalog({
      roots: [{ path: tempDir, source: "bundled", scope: "bundled" }],
      packageProvider: false,
      configProvider: () => ({}),
    });
    const snapshot = await catalog.snapshot();
    expect(snapshot).toMatchObject({
      diagnostics: [],
      plugins: [{
        id: "files",
        source: "bundled",
        scope: "bundled",
        enabled: true,
        machineSpecific: false,
        browserRoot: { path: "browser" },
        browserModule: { path: "browser/pi-web-plugin.js" },
      }],
    });
    const catalogEntry = snapshot.plugins[0];
    if (catalogEntry?.browserRoot === undefined) throw new Error("Built Files package has no browser root");
    const artifact = await readPiWebPluginPackageArtifact(catalogEntry.packageRoot, catalogEntry.browserRoot);
    expect(artifact.byteLength).toBeLessThan(PI_WEB_PLUGIN_ARTIFACT_MAX_BYTES);
    expect(await recursiveEntryCount(target)).toBeLessThan(PI_WEB_PLUGIN_ARTIFACT_MAX_ENTRIES);
    expect([...artifact.files.keys()].sort()).toEqual(
      packageFiles.filter((path) => path.startsWith("browser/")).sort(),
    );
  });

  it("keeps the dedicated Files source directory in plugin watch coverage", async () => {
    const watchDirectories = await findWatchDirs(resolve("pi-web-plugins"));
    expect(watchDirectories).toContain(resolve("pi-web-plugins/files"));
  });
});

function moduleSpecifiers(source) {
  const specifiers = [];
  const sourceFile = ts.createSourceFile("files-browser-bundle.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier !== undefined
      && ts.isStringLiteralLike(node.moduleSpecifier)) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1
      && node.arguments[0] !== undefined
      && ts.isStringLiteralLike(node.arguments[0])) {
      specifiers.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

async function recursiveFiles(root, base = root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await recursiveFiles(path, base));
    else if (entry.isFile()) files.push(relative(base, path).split(sep).join("/"));
  }
  return files.sort((left, right) => left.localeCompare(right));
}

async function recursiveEntryCount(root) {
  let count = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    count += 1;
    if (entry.isDirectory()) count += await recursiveEntryCount(join(root, entry.name));
  }
  return count;
}

async function withBrowserGlobals(action) {
  const browser = new Window({ url: "http://localhost/" });
  const names = [
    "window",
    "document",
    "customElements",
    "HTMLElement",
    "Element",
    "Node",
    "ShadowRoot",
    "Document",
    "CSSStyleSheet",
    "CustomEvent",
    "Event",
    "HTMLDialogElement",
    "HTMLInputElement",
    "File",
    "DOMException",
    "navigator",
  ];
  const previous = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const name of names) {
    const value = name === "window" ? browser : name === "document" ? browser.document : browser[name];
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }
  try {
    return await action();
  } finally {
    for (const name of names) {
      const descriptor = previous.get(name);
      if (descriptor === undefined) delete globalThis[name];
      else Object.defineProperty(globalThis, name, descriptor);
    }
    await browser.happyDOM.abort();
  }
}
