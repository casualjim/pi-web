import { homedir } from "node:os";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";
import { mkdir, readdir, stat } from "node:fs/promises";
import type { ClientFileSuggestion } from "../types.js";

export function expandUserPath(path: string): string {
  if (path === "" || path === "~") return homedir();
  if (path.startsWith(`~${sep}`) || path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return isAbsolute(path) ? resolve(path) : resolve(process.cwd(), path);
}

export async function listDirectorySuggestions(query = ""): Promise<ClientFileSuggestion[]> {
  const raw = query.trim();
  const expanded = expandUserPath(raw);
  const endsWithSeparator = raw === "" || raw.endsWith("/") || raw.endsWith("\\") || raw === "~";
  const parent = endsWithSeparator ? expanded : dirname(expanded);
  const search = endsWithSeparator ? "" : basename(expanded).toLowerCase();
  const entries = await readdir(parent, { withFileTypes: true });
  const suggestions: ClientFileSuggestion[] = [];

  for (const entry of entries) {
    if (!entry.name.toLowerCase().startsWith(search)) continue;
    let isDirectory = entry.isDirectory();
    const path = resolve(parent, entry.name);
    if (!isDirectory && entry.isSymbolicLink()) {
      try {
        isDirectory = (await stat(path)).isDirectory();
      } catch {
        isDirectory = false;
      }
    }
    if (isDirectory) suggestions.push({ path: `${path}/`, kind: "other" });
  }

  return suggestions.sort((a, b) => a.path.localeCompare(b.path)).slice(0, 80);
}

export async function createProjectDirectory(path: string): Promise<ClientFileSuggestion> {
  const raw = path.trim();
  if (raw === "") throw new Error("Directory path is required");
  const target = expandUserPath(raw);
  try {
    await mkdir(target);
  } catch (error) {
    if (isNodeErrorWithCode(error, "EEXIST")) throw new Error("Directory already exists", { cause: error });
    throw error;
  }
  return { path: `${target}/`, kind: "other" };
}

function isNodeErrorWithCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
