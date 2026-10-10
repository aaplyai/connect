/**
 * The compile-time half of moving runs between versions: the `migrations`
 * field of a definition, and the identity of an action.
 *
 * A version lists the earlier versions whose live runs may move to it, so
 * the compatibility claim is part of the definition's hash and is reviewed
 * with the version. Fact names on the new side are checked here; old names
 * can only be checked against a published source (`checkMigration`).
 */

import { keysOf } from "./definition-keys.js";
import type { DiagnosticBag } from "./diagnostics.js";
import { fingerprint } from "./hash.js";
import { isJsonObject, type JsonObject, type JsonValue, type PathSegment } from "./json.js";

/** Most entries a flow's `migrations` field holds (`flow/migration-invalid` beyond it). */
export const MAX_MIGRATIONS = 50;
/** Most source versions one `migrations` entry names in `from` (`flow/migration-invalid` beyond it). */
export const MAX_MIGRATION_SOURCES = 100;

/** One `migrations` entry, compiled. */
export interface CompiledMigration {
  /** Index of the entry in `migrations`. */
  index: number;
  /** The source versions the entry accepts. */
  from: string[];
  /** Old fact name to new fact name. */
  rename: ReadonlyMap<string, string>;
  /** New fact name to the old name it is renamed from. */
  renamedFrom: ReadonlyMap<string, string>;
  /** Facts (new names) asked again with their old value as prefill. */
  reask: ReadonlySet<string>;
  /** Facts (new names) that carry nothing over. */
  drop: ReadonlySet<string>;
}

/** What `compileMigrations` needs to know about the flow it compiles. */
export interface MigrationContext {
  /** The flow's own `version` as written: an entry may not name it in `from` (`flow/migration-self`). */
  version: unknown;
  /** Fact name to whether it is derived, and whether it is a collection; every fact of the flow. */
  facts: ReadonlyMap<string, { derived: boolean; list?: boolean }>;
  /** What a version in `from` must match (a flow version's pattern). */
  versionPattern: { test(value: string): boolean };
  /** What an old fact name in `rename` must match (a fact name's pattern). */
  namePattern: { test(value: string): boolean };
  /** The flow's fact limit, which bounds each entry's `rename`, `reask` and `drop`. */
  maxFacts: number;
}

/** Validates `migrations` and indexes the entries by source version. */
export function compileMigrations(raw: unknown, ctx: MigrationContext, bag: DiagnosticBag): Map<string, CompiledMigration> {
  const bySource = new Map<string, CompiledMigration>();
  if (raw === undefined) return bySource;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_MIGRATIONS) {
    bag.error("flow/migration-invalid", ["migrations"], `migrations must be a list of 1 to ${MAX_MIGRATIONS} entries`);
    return bySource;
  }
  raw.forEach((entry: unknown, index) => {
    const path: PathSegment[] = ["migrations", index];
    if (!isJsonObject(entry as JsonValue)) {
      bag.error("flow/migration-invalid", path, "a migration is {from, rename?, reask?, drop?}");
      return;
    }
    const e = entry as JsonObject;
    for (const key of Object.keys(e)) {
      if (!keysOf("migration").includes(key) && !key.startsWith("x-")) bag.error("flow/unknown-field", [...path, key], `unknown field "${key}"`);
    }
    const from = sources(e.from, [...path, "from"], ctx, bag);
    const known = (name: string, at: PathSegment[]): boolean => {
      const fact = ctx.facts.get(name);
      if (!fact) {
        bag.error("flow/unknown-fact", at, `unknown fact "${name}"`);
        return false;
      }
      if (fact.derived) {
        bag.error("flow/migration-derived", at, `"${name}" is derived: it is worked out again after a move, so it cannot be renamed into, asked again or dropped`);
        return false;
      }
      return true;
    };
    const rename = new Map<string, string>();
    const renamedFrom = new Map<string, string>();
    if (e.rename !== undefined) {
      if (!isJsonObject(e.rename) || Object.keys(e.rename).length > ctx.maxFacts) {
        bag.error("flow/migration-invalid", [...path, "rename"], "rename maps old fact names to new ones");
      } else {
        for (const [oldName, newName] of Object.entries(e.rename)) {
          const at: PathSegment[] = [...path, "rename", oldName];
          if (!ctx.namePattern.test(oldName) || typeof newName !== "string") {
            bag.error("flow/migration-invalid", at, "rename maps old fact names to new ones");
            continue;
          }
          if (oldName === newName) {
            bag.error("flow/migration-invalid", at, `"${oldName}" is renamed to itself`);
            continue;
          }
          if (!known(newName, at)) continue;
          // A collection carries by name, item by item; nothing inside an item is renamed.
          if (ctx.facts.get(newName)?.list) {
            bag.error("flow/migration-collection", at, `"${newName}" is a collection: it carries over by name, with its items, and cannot be renamed into`);
            continue;
          }
          const earlier = renamedFrom.get(newName);
          if (earlier !== undefined) {
            bag.error("flow/migration-conflict", at, `"${newName}" is renamed from both "${earlier}" and "${oldName}"`);
            continue;
          }
          rename.set(oldName, newName);
          renamedFrom.set(newName, oldName);
        }
      }
    }
    const list = (key: "reask" | "drop"): Set<string> => {
      const out = new Set<string>();
      const v = e[key];
      if (v === undefined) return out;
      if (!Array.isArray(v) || v.length > ctx.maxFacts || v.some((n) => typeof n !== "string")) {
        bag.error("flow/migration-invalid", [...path, key], `${key} must be a list of fact names`);
        return out;
      }
      v.forEach((name, i) => {
        if (known(name as string, [...path, key, i])) out.add(name as string);
      });
      return out;
    };
    const reask = list("reask");
    const drop = list("drop");
    for (const name of drop) {
      if (reask.has(name)) bag.error("flow/migration-conflict", [...path, "drop"], `"${name}" is both asked again and dropped`);
      if (renamedFrom.has(name)) bag.error("flow/migration-conflict", [...path, "drop"], `"${name}" is both renamed into and dropped`);
    }
    const compiled: CompiledMigration = { index, from, rename, renamedFrom, reask, drop };
    for (const version of from) {
      const other = bySource.get(version);
      if (other) bag.error("flow/migration-duplicate", [...path, "from"], `version "${version}" is already listed by migrations[${other.index}]`);
      else bySource.set(version, compiled);
    }
  });
  return bySource;
}

function sources(raw: JsonValue | undefined, path: PathSegment[], ctx: MigrationContext, bag: DiagnosticBag): string[] {
  const list = typeof raw === "string" ? [raw] : raw;
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_MIGRATION_SOURCES || list.some((v) => typeof v !== "string" || !ctx.versionPattern.test(v))) {
    bag.error("flow/migration-invalid", path, `from names 1 to ${MAX_MIGRATION_SOURCES} versions`);
    return [];
  }
  const out: string[] = [];
  for (const version of list as string[]) {
    if (version === ctx.version) bag.error("flow/migration-self", path, "a version cannot migrate from itself");
    else if (!out.includes(version)) out.push(version);
  }
  return out;
}

/** Action fields that do not change what the action is: how it is fed and how patiently it is retried. */
const NOT_IDENTITY = new Set(["input", "timeoutMs", "retry"]);

const withoutExtensions = (value: JsonValue): JsonValue => {
  if (!isJsonObject(value)) return value;
  const out: JsonObject = {};
  for (const key of Object.keys(value)) if (!key.startsWith("x-")) Object.defineProperty(out, key, { value: value[key], enumerable: true, writable: true, configurable: true });
  return out;
};

/**
 * The identity of an action: a fingerprint of its definition without its
 * input expressions, `timeoutMs`, `retry`, `hold.ttlMs`, `approval.ttlMs` and
 * `x-*` keys, with defaults filled in and approval roles sorted. It covers the
 * connector action, the connection, the pinned operation `contract` when
 * there is one, `actingFor`, `effect`, both schemas, `risk`, the approval
 * roles, `idempotent`, `commit`, `irreversible`, whether it holds, and the
 * full `compensate` and `reconcile` calls (their pins included). Fields a
 * later format adds count towards identity unless they are listed here as
 * not changing it.
 *
 * Across a move between versions, an action's result, held resources and
 * confirmations carry over only while its identity is unchanged: a
 * confirmation never covers a call it did not review. How long a review
 * lasts is not identity; a carried confirmation keeps the time it was given,
 * so a move never extends it (`Machine.moved`).
 */
export function actionIdentity(def: JsonObject): string {
  const out: JsonObject = {};
  for (const key of Object.keys(def).sort()) {
    if (key.startsWith("x-") || NOT_IDENTITY.has(key)) continue;
    const value = def[key]!;
    if (key === "hold" && isJsonObject(value)) {
      const { ttlMs: _ttl, ...rest } = withoutExtensions(value) as JsonObject;
      out.hold = rest;
    } else if (key === "approval" && isJsonObject(value)) {
      const { ttlMs: _ttl, ...approval } = withoutExtensions(value) as JsonObject;
      out.approval = { ...approval, ...(Array.isArray(approval.roles) ? { roles: [...new Set(approval.roles as string[])].sort() } : {}) };
    } else out[key] = withoutExtensions(value);
  }
  out.actingFor ??= "business";
  out.risk ??= "none";
  for (const flag of ["idempotent", "irreversible", "commit"]) out[flag] ??= false;
  return fingerprint(out);
}
