import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createProjectDirectory } from "./directorySuggestions.js";

describe("createProjectDirectory", () => {
  it("creates a single directory and returns it as a browse suggestion", async () => {
    const parent = await mkdtemp(join(tmpdir(), "pi-web-directory-suggestions-"));
    const target = join(parent, "new-workspace");

    const suggestion = await createProjectDirectory(target);

    expect(suggestion).toEqual({ path: `${target}/`, kind: "other" });
    expect((await stat(target)).isDirectory()).toBe(true);
    await rm(parent, { recursive: true, force: true });
  });

  it("rejects an existing directory instead of overwriting it", async () => {
    const parent = await mkdtemp(join(tmpdir(), "pi-web-directory-suggestions-"));

    await expect(createProjectDirectory(parent)).rejects.toThrow("Directory already exists");
    await rm(parent, { recursive: true, force: true });
  });

  it("rejects an empty path", async () => {
    await expect(createProjectDirectory("   ")).rejects.toThrow("Directory path is required");
  });
});
