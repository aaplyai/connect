import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The public entry points of this repository, discovered from every
 * package's `exports` (each entry with a `source` condition), never from a
 * list somebody keeps. Shared by api-surface.test.ts and frozen-exports.test.ts.
 */

export const ROOT = fileURLToPath(new URL("../", import.meta.url));

export interface Entry {
  /** The package name, for example `@aaply/flow`. */
  readonly pkg: string;
  /** The specifier a consumer imports, for example `@aaply/flow/decide`. */
  readonly specifier: string;
  /** The `exports` key, for example `./decide`. */
  readonly subpath: string;
  /** Absolute path of the entry's source file (its `source` condition). */
  readonly source: string;
  /** Absolute path of the package directory. */
  readonly dir: string;
  /** The `types` and `default` targets the build must emit, relative to `dir`. */
  readonly built: readonly string[];
}

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** A vendored package only this repository's tests use (`testOnly` in its VENDORED.json): its owner guards its API and size. */
export function isTestOnly(dir: string): boolean {
  const pin = join(dir, "VENDORED.json");
  return isFile(pin) && (JSON.parse(readFileSync(pin, "utf8")) as { testOnly?: boolean }).testOnly === true;
}

/** Every package directory under packages/ that has a package.json, but test-only ones. */
export function packageDirs(): string[] {
  return readdirSync(join(ROOT, "packages"))
    .sort()
    .map((name) => join(ROOT, "packages", name))
    .filter((dir) => isFile(join(dir, "package.json")) && !isTestOnly(dir));
}

/** Every exported entry point of every package, in a fixed order. */
export function discoverEntries(): Entry[] {
  const out: Entry[] = [];
  for (const dir of packageDirs()) {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name: string; exports?: Record<string, unknown> };
    for (const [subpath, conditions] of Object.entries(pkg.exports ?? {})) {
      // An entry the guard cannot read from source would ship with no budget or snapshot, so it is refused, never skipped.
      const c = (conditions !== null && typeof conditions === "object" ? conditions : {}) as Record<string, unknown>;
      if (typeof c.source !== "string") throw new Error(`${pkg.name} exports ${subpath} with no "source" condition; every entry needs one so the API guard can read it`);
      out.push({
        pkg: pkg.name,
        specifier: subpath === "." ? pkg.name : `${pkg.name}/${subpath.slice(2)}`,
        subpath,
        source: join(dir, c.source),
        dir,
        built: [c.types, c.default].filter((t): t is string => typeof t === "string"),
      });
    }
  }
  return out;
}
