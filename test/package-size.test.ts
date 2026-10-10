import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { packageDirs } from "./entries.js";

/**
 * Each package this repository owns stays under a ceiling of source lines.
 * The engine grew to 48,000 lines in three days, mostly from features no
 * user had asked for; a ceiling makes growth a decision. Raising one is a
 * reviewed change to this table, with the reason in the pull request.
 * Vendored packages (a VENDORED.json beside package.json) are owned and
 * guarded elsewhere.
 */
const CEILINGS: Readonly<Record<string, number>> = {
  connect: 7_000,
  connectors: 3_500,
};

function linesIn(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) total += linesIn(path);
    else if (entry.name.endsWith(".ts")) total += readFileSync(path, "utf8").split("\n").length - 1;
  }
  return total;
}

const owned = packageDirs().filter((dir) => !existsSync(join(dir, "VENDORED.json")));

describe("package size", () => {
  it("has a ceiling for every package this repository owns, and none for one it does not", () => {
    expect(owned.map((dir) => basename(dir)).sort()).toEqual(Object.keys(CEILINGS).sort());
  });

  for (const dir of owned) {
    const name = basename(dir);
    it(`keeps ${name} under its ceiling of source lines`, () => {
      const lines = existsSync(join(dir, "src")) ? linesIn(join(dir, "src")) : 0;
      expect(lines, `${name}: ${lines} lines`).toBeLessThanOrEqual(CEILINGS[name] ?? 0);
    });
  }
});
