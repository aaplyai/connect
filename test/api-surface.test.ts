import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { ROOT, discoverEntries, packageDirs, type Entry } from "./entries.js";

/**
 * The public surface of every package, held to what was decided (ADR 0016,
 * "Public entry points"). The entries are discovered from each package's
 * `exports` (every entry with a `source` condition); what each one exports is
 * read by the TypeScript checker, as a consumer resolving the `source`
 * condition sees it. docs/api-surface.json records every entry's names and,
 * in its header, a budget per entry.
 *
 * - Each entry exports at most its budget, and every entry has one.
 * - What each entry exports is what the snapshot records. Run with
 *   `UPDATE_API=1` to record a deliberate change; the diff is the review.
 * - No entry re-exports a whole module (`export *`): every public name is
 *   chosen where it is published.
 * - Within a package, a symbol has one home: one entry exports it.
 * - Every entry resolves in tests to its source (the aliases in
 *   vitest.config.ts are made from the same `exports`).
 * - Every name the reference docs' examples import is exported where they
 *   import it from.
 * - An `/internal` entry is imported only by the packages allowed to.
 */

const SNAPSHOT = join(ROOT, "docs/api-surface.json");
const UPDATE = process.env.UPDATE_API === "1";

/**
 * Who may import each package's `/internal` entry, besides the package that
 * owns it. Internals are shared between this repository's packages only;
 * anything a host or a connector needs is on a named entry instead.
 */
const INTERNAL_IMPORTERS: Readonly<Record<string, readonly string[]>> = {
  "@aaply/action-contract/internal": ["@aaply/connector-sdk"],
};

/**
 * Names one package exports from two of its entries. Each is a symbol that
 * should have one home; the list only shrinks.
 */
const SHARED_HOMES: Readonly<Record<string, readonly string[]>> = {};

interface Snapshot {
  readonly $comment: string;
  readonly budgets: Record<string, number>;
  readonly entries: Record<string, string[]>;
}

const entries = discoverEntries();

function compilerOptions(): ts.CompilerOptions {
  const base = ts.readConfigFile(join(ROOT, "tsconfig.base.json"), (path) => ts.sys.readFile(path));
  const parsed = ts.parseJsonConfigFileContent(base.config, ts.sys, ROOT);
  return { ...parsed.options, noEmit: true, types: ["node"], customConditions: ["source"] };
}

const program = ts.createProgram(
  entries.map((e) => e.source),
  compilerOptions(),
);
const checker = program.getTypeChecker();

function exportsOf(entry: Entry): ts.Symbol[] {
  const source = program.getSourceFile(entry.source);
  if (!source) throw new Error(`${entry.specifier}: ${entry.source} is not in the program`);
  const module = checker.getSymbolAtLocation(source);
  return module ? checker.getExportsOfModule(module) : [];
}

const resolved = (symbol: ts.Symbol): ts.Symbol => (symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol);

/** An entry's exports as sorted `name:v` (a value, or a class) and `name:t` (a type only). */
function surface(entry: Entry): string[] {
  return exportsOf(entry)
    .map((s) => `${s.name}:${resolved(s).flags & ts.SymbolFlags.Value ? "v" : "t"}`)
    .sort();
}

const current: Record<string, string[]> = Object.fromEntries(entries.map((e) => [e.specifier, surface(e)]));

function readSnapshot(): Snapshot {
  return JSON.parse(readFileSync(SNAPSHOT, "utf8")) as Snapshot;
}

/** Entries whose source re-exports a whole module (`export * from` or `export * as`). */
function starExporters(): string[] {
  return entries
    .filter((e) => {
      const source = ts.createSourceFile(e.source, readFileSync(e.source, "utf8"), ts.ScriptTarget.Latest, false);
      return source.statements.some((s) => ts.isExportDeclaration(s) && s.moduleSpecifier !== undefined && (s.exportClause === undefined || ts.isNamespaceExport(s.exportClause)));
    })
    .map((e) => e.specifier);
}

/** Names a package exports from more than one of its entries, as `name: entry, entry`. */
function sharedHomes(): Record<string, string[]> {
  const homes = new Map<ts.Symbol, { pkg: string; name: string; specifiers: string[] }>();
  for (const e of entries) {
    for (const s of exportsOf(e)) {
      const target = resolved(s);
      const seen = homes.get(target);
      if (seen && seen.pkg === e.pkg) seen.specifiers.push(e.specifier);
      else if (!seen) homes.set(target, { pkg: e.pkg, name: s.name, specifiers: [e.specifier] });
    }
  }
  const out: Record<string, string[]> = {};
  for (const { pkg, name, specifiers } of homes.values()) if (specifiers.length > 1) out[`${pkg}:${name}`] = specifiers.sort();
  return out;
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "corpus") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.(ts|mts|mjs|js|md)$/.test(name)) out.push(path);
  }
  return out;
}

/** The code blocks of a Markdown file, or the whole of a source file. */
function codeOf(file: string): string[] {
  const text = readFileSync(file, "utf8");
  return file.endsWith(".md") ? [...text.matchAll(/```(?:ts|typescript|js|javascript)\n([\s\S]*?)```/g)].map((m) => m[1]!) : [text];
}

/** Every name a Markdown file's code blocks import from a package entry, as `specifier: name`. */
function documentedImports(file: string): Array<{ specifier: string; name: string }> {
  const out: Array<{ specifier: string; name: string }> = [];
  for (const block of codeOf(file)) {
    const source = ts.createSourceFile(file, block, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
    for (const s of source.statements) {
      if (!ts.isImportDeclaration(s) || !ts.isStringLiteral(s.moduleSpecifier)) continue;
      const bindings = s.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) for (const el of bindings.elements) out.push({ specifier: s.moduleSpecifier.text, name: (el.propertyName ?? el.name).text });
    }
  }
  return out;
}

/** The reference docs: docs/*.md (not the ADRs, which record what was decided then) and every README. */
function referenceDocs(): string[] {
  return [
    join(ROOT, "README.md"),
    ...readdirSync(join(ROOT, "docs"))
      .filter((name) => name.endsWith(".md"))
      .map((name) => join(ROOT, "docs", name)),
    ...packageDirs().map((dir) => join(dir, "README.md")),
  ].filter((file) => {
    try {
      return statSync(file).isFile();
    } catch {
      return false;
    }
  });
}

/** Every module specifier a file imports or re-exports (in a Markdown file: in its code blocks). */
function importsOf(file: string): string[] {
  const out: string[] = [];
  for (const block of codeOf(file)) {
    const source = ts.createSourceFile(file, block, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
    const visit = (node: ts.Node): void => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) out.push(node.moduleSpecifier.text);
      else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) out.push(node.arguments[0].text);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return out;
}

describe("the public entry points", () => {
  it("are discovered from every package's exports, and each exports something", () => {
    expect(packageDirs().length).toBeGreaterThan(1);
    expect(entries.length).toBeGreaterThan(1);
    expect(entries.map((e) => e.specifier)).toContain("@aaply/connector-sdk");
    for (const e of entries) expect(current[e.specifier], e.specifier).not.toEqual([]);
  });

  it("each export at most their budget, and every entry has one", () => {
    const { budgets } = readSnapshot();
    expect(Object.keys(budgets).sort()).toEqual(Object.keys(current).sort());
    const over = Object.entries(current)
      .filter(([specifier, names]) => names.length > (budgets[specifier] ?? 0))
      .map(([specifier, names]) => `${specifier}: ${names.length} > ${budgets[specifier]}`);
    expect(over).toEqual([]);
  });

  it("export what docs/api-surface.json records (UPDATE_API=1 records a deliberate change)", () => {
    const snapshot = readSnapshot();
    if (UPDATE) {
      const next: Snapshot = { ...snapshot, entries: current };
      writeFileSync(SNAPSHOT, `${JSON.stringify(next, null, 2)}\n`);
      return;
    }
    expect(Object.keys(snapshot.entries).sort()).toEqual(Object.keys(current).sort());
    for (const [specifier, names] of Object.entries(current)) expect(names, specifier).toEqual(snapshot.entries[specifier]);
  });

  it("never re-export a whole module", () => {
    expect(starExporters()).toEqual([]);
  });

  it("give each symbol one home within its package", () => {
    expect(sharedHomes()).toEqual(SHARED_HOMES);
  });

  it("each resolve in tests to their source", async () => {
    for (const e of entries) {
      const bySpecifier: unknown = await import(/* @vite-ignore */ e.specifier);
      const bySource: unknown = await import(/* @vite-ignore */ e.source);
      expect(bySpecifier, e.specifier).toBe(bySource);
    }
  });

  it("are what the reference docs' examples import from", () => {
    const docs = referenceDocs();
    const imports = docs.flatMap((file) => documentedImports(file).map((i) => ({ ...i, file: relative(ROOT, file) })));
    // Examples also import the engine (@aaply/flow, ...), which lives in aaplyai/flow and is checked there.
    const packages = new Set(entries.map((e) => e.pkg));
    const ours = imports.filter((i) => [...packages].some((pkg) => i.specifier === pkg || i.specifier.startsWith(`${pkg}/`)));
    expect(ours.length).toBeGreaterThan(0);
    const missing = ours.filter((i) => !current[i.specifier]?.some((n) => n.startsWith(`${i.name}:`))).map((i) => `${i.file}: ${i.name} from ${i.specifier}`);
    expect(missing).toEqual([]);
  });

  it("an /internal entry is imported only by the packages allowed to", () => {
    const internal = entries.filter((e) => e.subpath === "./internal").map((e) => e.specifier);
    expect(internal.length).toBeGreaterThan(0);
    expect(Object.keys(INTERNAL_IMPORTERS).sort()).toEqual(internal.sort());
    const owners = new Map(entries.map((e) => [e.specifier, e.pkg]));
    const files = [...packageDirs().flatMap((dir) => sourceFiles(dir)), ...sourceFiles(join(ROOT, "scripts")), ...sourceFiles(join(ROOT, "docs")), join(ROOT, "README.md")];
    expect(files.length).toBeGreaterThan(50);
    const refused: string[] = [];
    let allowed = 0;
    for (const file of files) {
      const rel = relative(ROOT, file);
      const pkgDir = rel.startsWith("packages/") ? join(ROOT, rel.split("/").slice(0, 2).join("/")) : undefined;
      const importer = pkgDir ? (JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as { name: string }).name : rel;
      for (const specifier of importsOf(file)) {
        if (!internal.includes(specifier)) continue;
        if (owners.get(specifier) === importer || INTERNAL_IMPORTERS[specifier]?.includes(importer)) allowed++;
        else refused.push(`${rel} imports ${specifier}`);
      }
    }
    expect(refused).toEqual([]);
    expect(allowed).toBeGreaterThan(0);
  });
});
