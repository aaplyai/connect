import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { packageDirs, ROOT } from "./entries.js";

/**
 * No source file grows past a budget of lines. A file that large holds more
 * than one thing; it is split along its seams. The sources are discovered on disk: every
 * `.ts` file under `src/` of every package. A file may stay over the budget
 * only by an entry below that says why, and an entry is held to a file that
 * exists and is still over it, so the list only shrinks.
 */

const BUDGET = 800;

/** Files allowed over the budget, by path from the repository root, each with its reason. */
const ALLOWED: Readonly<Record<string, string>> = {};

/** Every `.ts` file under `dir`, recursively, by absolute path. */
function sourcesIn(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourcesIn(path));
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

/** Lines in a file's text, as `wc -l` counts them for a file that ends with a newline. */
function lineCount(text: string): number {
  if (text.length === 0) return 0;
  const lines = text.split("\n").length;
  return text.endsWith("\n") ? lines - 1 : lines;
}

/** The files over `budget` lines that `allowed` does not name. */
function oversized(files: ReadonlyMap<string, number>, budget: number, allowed: Readonly<Record<string, string>>): string[] {
  return [...files].filter(([path, lines]) => lines > budget && !Object.hasOwn(allowed, path)).map(([path, lines]) => `${path}: ${lines} lines`);
}

/** Every package's sources, by path from the repository root (with `/`), and their line counts. */
function discover(): Map<string, number> {
  const files = new Map<string, number>();
  for (const dir of packageDirs()) {
    let paths: string[];
    try {
      paths = sourcesIn(join(dir, "src"));
    } catch {
      continue;
    }
    for (const path of paths) files.set(relative(ROOT, path).split(sep).join("/"), lineCount(readFileSync(path, "utf8")));
  }
  return files;
}

describe("source file size", () => {
  const files = discover();

  it("discovers the sources of every package", () => {
    expect(files.size).toBeGreaterThan(0);
    // Found by name, not by size: the files this guard was written for are among them.
    for (const path of ["packages/connector-sdk/src/port.ts", "packages/action-contract/src/approved.ts"]) expect(files.has(path), path).toBe(true);
    const packages = new Set([...files.keys()].map((path) => path.split("/")[1]));
    expect(packages.size).toBeGreaterThan(1);
  });

  it(`keeps every source file at ${BUDGET} lines or fewer, but those allowed`, () => {
    expect(oversized(files, BUDGET, ALLOWED)).toEqual([]);
  });

  it("allows only files that exist and are still over the budget", () => {
    const stale = Object.keys(ALLOWED).filter((path) => (files.get(path) ?? 0) <= BUDGET);
    expect(stale).toEqual([]);
    for (const [path, why] of Object.entries(ALLOWED)) expect(why.length, path).toBeGreaterThan(0);
  });

  it("reports a file over the budget, and only that one", () => {
    const sample = new Map([
      ["packages/x/src/a.ts", BUDGET],
      ["packages/x/src/b.ts", BUDGET + 1],
      ["packages/x/src/c.ts", BUDGET + 500],
    ]);
    expect(oversized(sample, BUDGET, {})).toEqual([`packages/x/src/b.ts: ${BUDGET + 1} lines`, `packages/x/src/c.ts: ${BUDGET + 500} lines`]);
    expect(oversized(sample, BUDGET, { "packages/x/src/c.ts": "a reason" })).toEqual([`packages/x/src/b.ts: ${BUDGET + 1} lines`]);
  });

  it("counts lines as wc -l does", () => {
    expect(lineCount("")).toBe(0);
    expect(lineCount("a\n")).toBe(1);
    expect(lineCount("a\nb")).toBe(2);
    expect(lineCount("a\nb\n")).toBe(2);
  });
});
