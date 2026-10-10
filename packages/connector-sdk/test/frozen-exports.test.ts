import { describe, expect, it } from "vitest";
import * as sdk from "../src/index.js";
import { CONNECTOR_ID_RE, SEMVER_RE } from "../src/definition.js";

/**
 * Nothing @aaply/connector-sdk exports can be changed at run time: every
 * table is frozen at every depth, and no export is a RegExp (whose `compile`
 * changes what it matches in place) or a Set or Map (whose `add` and `set`
 * work on a frozen one). The exports are discovered from the entry point.
 */

function mutableIn(value: unknown, at: string, out: string[] = [], seen = new Set<unknown>()): string[] {
  if (value === null || typeof value !== "object" || seen.has(value)) return out;
  seen.add(value);
  if (value instanceof RegExp || value instanceof Set || value instanceof Map) out.push(`${at}: ${value.constructor.name}`);
  else if (!Object.isFrozen(value)) out.push(`${at}: not frozen`);
  for (const key of Object.keys(value)) mutableIn((value as Record<string, unknown>)[key], `${at}.${key}`, out, seen);
  return out;
}

describe("the exports of @aaply/connector-sdk", () => {
  it("no table can be changed, and no export is a RegExp, Set or Map", () => {
    const exports = Object.entries(sdk);
    expect(exports.length).toBeGreaterThan(10);
    expect(exports.flatMap(([k, v]) => mutableIn(v, k))).toEqual([]);
  });

  it("keeps its patterns as a source and a test", () => {
    expect(CONNECTOR_ID_RE.test("my-crm")).toBe(true);
    expect(CONNECTOR_ID_RE.test("My CRM")).toBe(false);
    expect("compile" in SEMVER_RE).toBe(false);
  });
});
