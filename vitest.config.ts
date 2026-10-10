import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL("./", import.meta.url));
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/**
 * Tests run against package sources, so no build is needed first. The aliases
 * are made from every package's `exports`: each entry with a `source`
 * condition is one alias, so a new subpath resolves in tests the moment its
 * package lists it (api-surface.test.ts checks every entry resolves here).
 * A package that exports nothing (@aaply/flow-cli) gets no alias, and nothing
 * outside it may import it.
 */
export function sourceAliases(): Array<{ find: RegExp; replacement: string }> {
  const aliases: Array<{ find: RegExp; replacement: string }> = [];
  for (const dir of readdirSync(join(root, "packages"))) {
    const manifest = join(root, "packages", dir, "package.json");
    try {
      if (!statSync(manifest).isFile()) continue;
    } catch {
      continue;
    }
    const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { name: string; exports?: Record<string, { source?: string } | string> };
    for (const [subpath, conditions] of Object.entries(pkg.exports ?? {})) {
      if (typeof conditions !== "object" || typeof conditions.source !== "string") continue;
      const specifier = subpath === "." ? pkg.name : `${pkg.name}/${subpath.slice(2)}`;
      aliases.push({ find: new RegExp(`^${escape(specifier)}$`), replacement: join(root, "packages", dir, conditions.source) });
    }
  }
  return aliases;
}

export default defineConfig({
  resolve: { alias: sourceAliases() },
  test: {
    include: ["packages/*/test/**/*.test.ts", "test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
