import { describe, expect, it } from "vitest";
import { MAX_PATTERN_SUBJECT, MAX_PATTERN_WORK, checkPattern, validateValue } from "../src/index.js";
import { MAX_PATTERN_STATES, compilePattern, patternMatches, type CompiledPattern } from "../src/api/internal.js";

function compiled(pattern: string): CompiledPattern {
  const c = compilePattern(pattern);
  if (typeof c === "string") throw new Error(`${pattern}: ${c}`);
  return c;
}

/** A small seeded generator (mulberry32), so a failure names a reproducible case. */
function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ATOMS = ["a", "b", "1", " ", "\\.", "\\-", "é", "😀", "\\u{1F600}", "\\x61", "\\u0062", "[ab]", "[^a]", "[a-c]", "[\\d ]", "[^\\s1]", "[]", "[^]", "\\d", "\\D", "\\w", "\\W", "\\s", "\\S", ".", "\\p{L}", "\\P{L}", "\\p{Nd}", "\\p{sc=Latin}", "[\\p{Lu}1]"];
const QUANTIFIERS = ["", "", "", "*", "+", "?", "{2}", "{1,3}", "{0,2}", "{2,}", "*?", "+?", "??", "{1,2}?"];
const ASSERTIONS = ["^", "$", "\\b", "\\B"];

function generate(next: () => number, depth: number): string {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!;
  const term = (): string => {
    const r = next();
    if (r < 0.1) return pick(ASSERTIONS);
    const atom = depth > 0 && r < 0.3 ? `${pick(["(", "(?:", "(?<g>"])}${generate(next, depth - 1)})` : pick(ATOMS);
    return atom + pick(QUANTIFIERS);
  };
  const alternative = () => Array.from({ length: 1 + Math.floor(next() * 4) }, term).join("");
  return next() < 0.2 ? `${alternative()}|${alternative()}` : alternative();
}

const SUBJECT_CHARS = ["a", "b", "1", " ", ".", "-", "é", "A", "_", "😀", "\ud800", "\n"];

describe("the linear-time pattern matcher", () => {
  it("answers as the native engine does, on generated patterns and subjects", () => {
    const next = random(20261009);
    let compared = 0;
    for (let n = 0; n < 3000; n++) {
      const pattern = generate(next, 2);
      let native: RegExp;
      try {
        native = new RegExp(pattern, "u");
      } catch {
        continue;
      }
      const c = compiled(pattern);
      for (let k = 0; k < 8; k++) {
        // Short subjects over every kind of character, and longer repetitive ones, which the matcher's cache of thread sets serves.
        const chars = k < 6 ? SUBJECT_CHARS : SUBJECT_CHARS.slice(0, 3);
        const subject = Array.from({ length: Math.floor(next() * (k < 6 ? 9 : 17)) }, () => chars[Math.floor(next() * chars.length)]).join("");
        expect(patternMatches(c, subject), `${JSON.stringify(pattern)} on ${JSON.stringify(subject)}`).toBe(native.test(subject));
        compared++;
      }
    }
    // The generator must reach the cases it is for.
    expect(compared).toBeGreaterThan(10_000);
  });

  it("searches anywhere unless anchored, over code points", () => {
    expect(patternMatches(compiled("b"), "abc")).toBe(true);
    expect(patternMatches(compiled("^b"), "abc")).toBe(false);
    expect(patternMatches(compiled("^.$"), "😀")).toBe(true);
    expect(patternMatches(compiled("^..$"), "😀")).toBe(false);
    expect(patternMatches(compiled("^\\uD83D\\uDE00$"), "😀")).toBe(true);
    expect(patternMatches(compiled(""), "")).toBe(true);
    expect(patternMatches(compiled("[]"), "abc")).toBe(false);
  });

  it("refuses what it cannot run in linear time, or is too large", () => {
    expect(checkPattern("(a)\\1")).toMatch(/backreferences/);
    expect(checkPattern("(?<x>a)\\k<x>")).toMatch(/backreferences/);
    expect(checkPattern("(?=a)a")).toMatch(/lookahead/);
    expect(checkPattern("(?!a)b")).toMatch(/lookahead/);
    expect(checkPattern("(?<=a)b")).toMatch(/lookbehind/);
    expect(checkPattern("(?:a{1,100}){1,100}")).toMatch(/too large/);
    expect(checkPattern(`a{${MAX_PATTERN_STATES + 1}}`)).toMatch(/too large/);
    expect(checkPattern("a{1,900}")).toBeNull();
    expect(checkPattern("[")).toMatch(/compile/);
  });

  // Every one of these was accepted by some version of the old backtracking screen, or is the classic case.
  const adversarial = [
    "(a+)+$",
    "(a|a)*!",
    "(a|b)*!",
    "^((ab)*c)+$",
    "(x?y)*!",
    "a*a*a*a*!",
    "\\d+\\.?\\d+!",
    "a{1,50}a{1,50}a{1,50}a{1,50}!",
    "a{1,50}a{1,50}a{1,50}a{1,50}a{1,50}a{1,50}!",
    "\\w{1,99}\\w{1,99}\\w{1,99}!",
    "(a{1,3}a{1,3}x)".repeat(16) + "!",
    "\\w+\\d{1,8}!",
    "\\w+\\d?\\d?\\d?!",
    "\\d+\\d{1,30}!",
    "\\p{sc=Cherokee}+\\p{sc=Cherokee}+\\p{sc=Cherokee}+!",
    "[^@]+\\p{sc=Cherokee}+!",
    "(?:(?:a|ab|b)*)*!",
    "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$",
    ".*a.*a.*a.*a.*!",
    "a?".repeat(40) + "a".repeat(40),
    "(?:a{1,20}){1,20}!",
    "(?:.{1,9}){1,9}x{1,9}!",
  ];
  const subjects = ["a".repeat(MAX_PATTERN_SUBJECT), "ab".repeat(MAX_PATTERN_SUBJECT / 2), "1".repeat(MAX_PATTERN_SUBJECT), "Ꭰ".repeat(MAX_PATTERN_SUBJECT), "aax".repeat(MAX_PATTERN_SUBJECT / 3), "a@".repeat(MAX_PATTERN_SUBJECT / 2)];

  it("matches every shape that backtracks badly in linear time, on the longest subject", () => {
    for (const p of adversarial) {
      expect(checkPattern(p), p).toBeNull();
      for (const subject of subjects) {
        const started = performance.now();
        validateValue({ type: "string", pattern: p }, subject);
        expect(performance.now() - started, `${p} on ${subject.slice(0, 4)}…`).toBeLessThan(250);
      }
    }
  });

  it("matches the largest program it accepts within bounds", () => {
    const p = "(?:[a-z]{1,9}\\d?){1,95}!";
    expect(checkPattern(p)).toBeNull();
    // A subject that does not repeat defeats the cache, and the plain simulation runs.
    const next = random(7);
    const varied = Array.from({ length: MAX_PATTERN_SUBJECT }, () => "abcdefghij1"[Math.floor(next() * 11)]).join("");
    for (const subject of ["a1".repeat(MAX_PATTERN_SUBJECT / 2), "a".repeat(MAX_PATTERN_SUBJECT), varied]) {
      const started = performance.now();
      validateValue({ type: "string", pattern: p }, subject);
      // Every state can be live on every character; well under this where it was written.
      expect(performance.now() - started).toBeLessThan(750);
    }
  });

  it("accepts ordinary patterns and matches them as written", () => {
    const cases: Array<[string, string[], string[]]> = [
      ["^\\+?[0-9]{7,15}$", ["+447911123456", "9876543210"], ["+44 7911", "abc"]],
      ["^\\+[1-9]\\d{1,14}$", ["+14155552671"], ["+0123", "14155552671"]],
      ["^\\+?\\d{1,3}[ -]?\\d{6,12}$", ["+91 9876543210", "44-7911123456"], ["+91 98"]],
      ["^[A-Z]{1,2}[0-9][A-Z0-9]? ?[0-9][A-Z]{2}$", ["SW1A 1AA", "M1 1AE"], ["SW1A-1AA"]],
      ["^\\d{5}(-\\d{4})?$", ["94105", "94105-1234"], ["9410"]],
      ["^[1-9][0-9]{5}$", ["560001"], ["060001"]],
      ["^[A-Z]{5}[0-9]{4}[A-Z]$", ["ABCDE1234F"], ["ABCD1234F"]],
      ["^[2-9]\\d{3}\\s?\\d{4}\\s?\\d{4}$", ["2345 6789 0123", "234567890123"], ["1234 5678 9012"]],
      ["^\\d{2}[A-Z]{5}\\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$", ["22AAAAA0000A1Z5"], ["22AAAAA0000A1X5"]],
      ["^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", ["a.b@example.co.uk"], ["a@b", "a b@c.d"]],
      ["^[a-z0-9._%+-]{1,64}@[a-z0-9-]{1,63}(\\.[a-z0-9-]{1,63}){1,8}$", ["first.last@mail.example.com"], ["first@last@x.com"]],
      ["^\\p{L}+(?:[ '-]\\p{L}+)*$", ["Zoë O'Brien-Smith", "李 小龙"], ["Bob  Smith", "R2D2"]],
      ["^((25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)\\.){3}(25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)$", ["192.168.0.1", "8.8.8.8"], ["256.1.1.1", "1.2.3"]],
      ["^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", ["123e4567-e89b-12d3-a456-426614174000"], ["123e4567"]],
      ["\\bfoo\\b", ["a foo b"], ["food"]],
    ];
    for (const [p, good, bad] of cases) {
      expect(checkPattern(p), p).toBeNull();
      const native = new RegExp(p, "u");
      for (const s of [...good, ...bad]) expect(patternMatches(compiled(p), s), `${p} on ${s}`).toBe(native.test(s));
      for (const s of good) expect(native.test(s), `${p} on ${s}`).toBe(true);
      for (const s of bad) expect(native.test(s), `${p} on ${s}`).toBe(false);
    }
  });

  it("goes back to its cache once the thread sets settle", () => {
    // `.{1,999}!` meets a new set on each of its first 999 characters, then the same one.
    const budget = { left: 1e9 };
    expect(patternMatches(compiled(".{1,999}!"), "a".repeat(MAX_PATTERN_SUBJECT), budget)).toBe(false);
    // Without the cache the remaining 9,000 characters would cost 999 threads each.
    expect(1e9 - budget.left).toBeLessThan(3_000_000);
  });

  it("bounds the work of one validation, and says when a value is too costly to check", () => {
    const started = performance.now();
    const issues = validateValue({ type: "array", items: { type: "string", pattern: ".{1,999}!" } }, Array.from({ length: 6 }, () => "a".repeat(MAX_PATTERN_SUBJECT)));
    expect(performance.now() - started).toBeLessThan(500);
    expect(issues.some((x) => x.code === "pattern" && /too costly/.test(x.message))).toBe(true);
    // An ordinary form is nowhere near the budget.
    const form = { type: "object" as const, properties: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`f${i}`, { type: "string" as const, pattern: "^[\\p{L}0-9 .,'-]{1,500}$" }])) };
    const values = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`f${i}`, "Flat 4, 12 O'Neill Street ".repeat(19).slice(0, 500)]));
    expect(validateValue(form, values)).toEqual([]);
    expect(MAX_PATTERN_WORK).toBeGreaterThan(0);
  });
});

