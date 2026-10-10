import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isTestOnly, packageDirs, ROOT } from "./entries.js";

/** Every `.ts` file under `dir`, recursively. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));
}

/**
 * A vendored package is a read-only copy of a package another repository
 * owns (see scripts/vendor.mjs). Its files must match the digest pinned in
 * its VENDORED.json: a change belongs in the owner repository, then a sync.
 */
describe("vendored packages", () => {
  it("match the commit they are pinned to", () => {
    expect(() => execFileSync(process.execPath, [join(ROOT, "scripts/vendor.mjs"), "check"], { encoding: "utf8", stdio: "pipe" })).not.toThrow();
  });

  it("leave a test-only package to tests: no package depends on it, and no source imports it", () => {
    const testOnly = readdirSync(join(ROOT, "packages"))
      .map((name) => join(ROOT, "packages", name))
      .filter(isTestOnly)
      .map((dir) => (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name: string }).name);
    expect(testOnly).toEqual(["@aaply/flow"]);
    const problems: string[] = [];
    for (const dir of packageDirs()) {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name: string; dependencies?: Record<string, string> };
      for (const name of testOnly) if (pkg.dependencies?.[name]) problems.push(`${pkg.name} depends on ${name}`);
      let files: string[] = [];
      try {
        files = sources(join(dir, "src"));
      } catch {
        continue;
      }
      for (const file of files) {
        const text = readFileSync(file, "utf8");
        for (const name of testOnly) if (text.includes(`"${name}"`) || text.includes(`"${name}/`)) problems.push(`${file} imports ${name}`);
      }
    }
    expect(problems).toEqual([]);
  });
});
