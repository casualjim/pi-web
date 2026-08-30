import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readContributionQuery,
  readContributionQueryRecord,
  setContributionQueryKey,
  writeContributionQueryRecord,
} from "./namespacedQueryArgs";

const originalWindow = globalThis.window;

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(globalThis, "window", { value: originalWindow, configurable: true });
});

describe("contribution-scoped query helpers", () => {
  it("reads canonical values before aliases and keeps history snapshots independent", () => {
    const browser = installWindow("https://example.test/app?machine=remote&project=p1&workspace=w1&panel.workspace.panel--file=canonical.ts&legacy.workspace.panel--file=legacy.ts&legacy.workspace.panel--mode=preview&panel.workspace.panel--tag=one&panel.workspace.panel--tag=two");

    const first = readContributionQuery("panel:workspace.panel", ["legacy:workspace.panel"]);
    expect(first).toEqual({ file: "canonical.ts", mode: "preview", tag: ["one", "two"] });

    browser.navigate("https://example.test/app?machine=remote&project=p1&workspace=w1&legacy.workspace.panel--file=back.ts");
    const restored = readContributionQuery("panel:workspace.panel", ["legacy:workspace.panel"]);

    expect(restored).toEqual({ file: "back.ts" });
    expect(first).toEqual({ file: "canonical.ts", mode: "preview", tag: ["one", "two"] });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first["tag"])).toBe(true);
  });

  it("canonicalizes alias writes with push/replace history and validates local keys", () => {
    const browser = installWindow("https://example.test/base/app?project=p1&workspace=w1&panel.workspace.panel--file=old.ts&legacy.workspace.panel--file=legacy.ts&other.workspace.panel--keep=yes&plain=kept#viewer");

    expect(setContributionQueryKey("panel:workspace.panel", ["legacy:workspace.panel"], "file", ["src/a.ts", 2, true])).toBe(true);
    expect(browser.pushed).toHaveLength(1);
    expect(browser.replaced).toHaveLength(0);
    expect(browser.url.searchParams.getAll("panel.workspace.panel--file")).toEqual(["src/a.ts", "2", "true"]);
    expect(browser.url.searchParams.has("legacy.workspace.panel--file")).toBe(false);
    expect(browser.url.searchParams.get("other.workspace.panel--keep")).toBe("yes");
    expect(browser.url.searchParams.get("plain")).toBe("kept");
    expect(browser.url.pathname).toBe("/base/app");
    expect(browser.url.hash).toBe("#viewer");

    expect(setContributionQueryKey("panel:workspace.panel", ["legacy:workspace.panel"], "mode", "raw", { replace: true })).toBe(true);
    expect(browser.replaced).toHaveLength(1);
    expect(browser.url.searchParams.get("panel.workspace.panel--mode")).toBe("raw");

    expect(() => setContributionQueryKey("panel:workspace.panel", [], "Bad Key", "value")).toThrow("Invalid contribution navigation key");
    expect(() => {
      Reflect.apply(setContributionQueryKey, undefined, ["panel:workspace.panel", [], "mode", { invalid: true }]);
    }).toThrow("Invalid contribution navigation value for key: mode");
    expect(browser.pushed).toHaveLength(1);
    expect(browser.replaced).toHaveLength(1);
  });

  it("captures and restores only bounded contribution-owned parameters", () => {
    const browser = installWindow("https://example.test/app?project=p1&workspace=w1&panel.workspace.panel--file=one&panel.workspace.panel--file=two&plain=kept&bad--query=ignored#hash");

    expect(readContributionQueryRecord()).toEqual({
      "panel.workspace.panel--file": ["one", "two"],
    });

    expect(writeContributionQueryRecord({
      "next.workspace.panel--mode": "preview",
      "next.workspace.panel--selection": ["a", "b"],
      "invalid": "ignored",
    }, { replace: true })).toBe(true);

    expect(browser.url.searchParams.get("project")).toBe("p1");
    expect(browser.url.searchParams.get("workspace")).toBe("w1");
    expect(browser.url.searchParams.get("plain")).toBe("kept");
    expect(browser.url.searchParams.get("bad--query")).toBe("ignored");
    expect(browser.url.searchParams.has("panel.workspace.panel--file")).toBe(false);
    expect(browser.url.searchParams.get("next.workspace.panel--mode")).toBe("preview");
    expect(browser.url.searchParams.getAll("next.workspace.panel--selection")).toEqual(["a", "b"]);
    expect(browser.url.hash).toBe("#hash");
  });
});

function installWindow(href: string): {
  readonly url: URL;
  readonly pushed: string[];
  readonly replaced: string[];
  navigate(next: string): void;
} {
  let current = new URL(href);
  const pushed: string[] = [];
  const replaced: string[] = [];
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
  const fakeWindow = {
    location,
    history: {
      pushState: vi.fn((_state: object, _title: string, next: URL | string) => { commit(next, pushed); }),
      replaceState: vi.fn((_state: object, _title: string, next: URL | string) => { commit(next, replaced); }),
    },
  };
  Object.defineProperty(globalThis, "window", { value: fakeWindow, configurable: true });
  return {
    get url() { return current; },
    pushed,
    replaced,
    navigate: (next) => { current = new URL(next, current); },
  };
}
