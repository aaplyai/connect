/**
 * A linear-time matcher for the `pattern` keyword.
 *
 * Patterns are tenant- or model-authored, and V8's engine backtracks: a
 * pattern such as `(a|a)*!` can hold the shared runtime for minutes on a
 * short value. So patterns never run on it. They are compiled to a small
 * program and run by simulating every path at once (a Pike VM), which takes
 * time proportional to the subject's length times the program's size,
 * whatever the pattern. The sets of states met are cached with where each
 * character leads, so a repetitive value costs about one lookup a character.
 *
 * The subset is ECMAScript's `u` mode without what needs backtracking:
 * literals and escapes, `.`, classes with ranges and negation, `\d \w \s`
 * and their negations, `\p{…}` and `\P{…}`, groups (capturing or not; named
 * groups are accepted, captures are not kept), alternation, the quantifiers
 * `* + ? {n} {n,} {n,m}` (lazy forms too: matching is yes or no, so they
 * mean the same), and `^ $ \b \B`. Backreferences, lookahead and lookbehind
 * are refused, and so is a program longer than {@link MAX_PATTERN_STATES}
 * (counts are expanded, so `(?:a{1,100}){1,100}` is too long).
 *
 * Matching is JSON Schema's: the pattern may match anywhere in the value
 * unless it is anchored, over code points.
 */

/**
 * Longest compiled program a pattern may have. Matching follows at most this
 * many states per character. A pattern near the cap on a 10,000-character
 * value that never repeats (so the cache of thread sets cannot help) took
 * under 200 ms where this was written; ordinary patterns take a few.
 */
export const MAX_PATTERN_STATES = 2_000;

/** A compiled pattern: run it with {@link patternMatches}. */
export interface CompiledPattern {
  readonly op: Uint8Array;
  readonly arg: Int32Array;
  readonly arg2: Int32Array;
  /** For a class state, which of `tests` it reads. */
  readonly cls: Int32Array;
  readonly tests: readonly CharTest[];
}

type CharTest = (cp: number) => boolean;

type Node =
  | { k: "lit"; cp: number }
  | { k: "char"; test: CharTest }
  | { k: "assert"; kind: number }
  | { k: "seq"; items: Node[] }
  | { k: "alt"; alts: Node[] }
  | { k: "rep"; node: Node; min: number; max: number };

const CHAR = 0;
const SPLIT = 1;
const JMP = 2;
const ASSERT = 3;
const MATCH = 4;
const LIT = 5;

const START = 0;
const END = 1;
const BOUNDARY = 2;
const NOT_BOUNDARY = 3;

class Unsupported extends Error {}

/**
 * Compiles a pattern, or says why it cannot be: the pattern must already
 * compile as a native `u`-mode RegExp (the caller checks that first).
 */
export function compilePattern(pattern: string): CompiledPattern | string {
  let ast: Node;
  try {
    ast = new Parser(pattern).parse();
  } catch (error) {
    if (error instanceof Unsupported) return error.message;
    throw error;
  }
  if (size(ast) + 1 > MAX_PATTERN_STATES) return `pattern is too large to match safely (more than ${MAX_PATTERN_STATES} states once its counts are expanded)`;
  const program = new Program();
  program.emit(ast);
  program.add(MATCH, 0, 0, null);
  return { op: Uint8Array.from(program.op), arg: Int32Array.from(program.arg), arg2: Int32Array.from(program.arg2), cls: Int32Array.from(program.cls), tests: program.tests };
}

/** Work a caller lets matches spend, shared across them: {@link patternMatches} draws on `left`. */
export interface PatternBudget {
  left: number;
}

/**
 * True when the pattern matches anywhere in `subject` (JSON Schema's
 * unanchored search). Null when `budget` ran out first: a unit is one
 * thread followed on one character, or one state of a set the cache keeps.
 */
export function patternMatches(p: CompiledPattern, subject: string, budget: PatternBudget = { left: Infinity }): boolean | null {
  const points: number[] = [];
  for (const ch of subject) points.push(ch.codePointAt(0)!);
  const cps = Int32Array.from(points);
  const length = cps.length;
  const { op, arg, arg2, cls, tests } = p;
  const n = op.length;
  let current = new Int32Array(n);
  let next = new Int32Array(n);
  let currentCount = 0;
  const seen = new Int32Array(n).fill(-1);
  const stack = new Int32Array(n + 1);
  // One answer per class and character, however many states test it.
  const testedAt = new Int32Array(tests.length).fill(-1);
  const tested = new Uint8Array(tests.length);
  const holds = (kind: number, pos: number): boolean => {
    if (kind === START) return pos === 0;
    if (kind === END) return pos === length;
    const boundary = (pos > 0 && isWord(cps[pos - 1]!)) !== (pos < length && isWord(cps[pos]!));
    return kind === BOUNDARY ? boundary : !boundary;
  };
  // Adds the threads reachable from `pc` without reading a character; -1 when one matches.
  const add = (list: Int32Array, count: number, pc: number, pos: number): number => {
    if (seen[pc] === pos) return count;
    seen[pc] = pos;
    let top = 0;
    stack[top++] = pc;
    while (top > 0) {
      const at = stack[--top]!;
      const code = op[at];
      if (code === LIT || code === CHAR) list[count++] = at;
      else if (code === MATCH) return -1;
      else {
        const a = code === ASSERT ? (holds(arg[at]!, pos) ? at + 1 : -1) : arg[at]!;
        const b = code === SPLIT ? arg2[at]! : -1;
        if (b >= 0 && seen[b] !== pos) {
          seen[b] = pos;
          stack[top++] = b;
        }
        if (a >= 0 && seen[a] !== pos) {
          seen[a] = pos;
          stack[top++] = a;
        }
      }
    }
    return count;
  };
  // One step of the simulation: the threads at `pos + 1` after reading the character at `pos`.
  const step = (pos: number): number => {
    budget.left -= currentCount + 1;
    const cp = cps[pos]!;
    let nextCount = 0;
    for (let t = 0; t < currentCount; t++) {
      const pc = current[t]!;
      if (op[pc] === LIT) {
        if (arg[pc] !== cp) continue;
      } else {
        const c = cls[pc]!;
        if (testedAt[c] !== pos) {
          testedAt[c] = pos;
          tested[c] = tests[c]!(cp) ? 1 : 0;
        }
        if (tested[c] === 0) continue;
      }
      nextCount = add(next, nextCount, pc + 1, pos + 1);
      if (nextCount < 0) return -1;
    }
    // A match may start at every position.
    return add(next, nextCount, 0, pos + 1);
  };
  currentCount = add(current, 0, 0, 0);
  if (currentCount < 0) return true;
  // The sets of threads are cached as they are met, with where each character leads (a lazy DFA),
  // so a repetitive value costs one lookup a character. What a step does depends only on the set,
  // the character, and whether the next position is the end or before a word character.
  const cache = new ThreadSets();
  let state = cache.intern(current, currentCount);
  for (let pos = 0; pos < length; pos++) {
    if (budget.left < 0) return null;
    const key = cps[pos]! * 4 + (pos + 1 === length ? 2 : 0) + (pos + 1 < length && isWord(cps[pos + 1]!) ? 1 : 0);
    const known = state >= 0 ? cache.target(state, key) : undefined;
    if (known !== undefined) {
      state = known;
      budget.left--;
      const pcs = cache.pcs(state);
      current.set(pcs);
      currentCount = pcs.length;
      continue;
    }
    const nextCount = step(pos);
    if (nextCount < 0) return true;
    const swap = current;
    current = next;
    next = swap;
    currentCount = nextCount;
    const to = cache.intern(current, currentCount);
    if (to >= 0) budget.left -= currentCount;
    if (state >= 0 && to >= 0) cache.link(state, key, to);
    state = to;
  }
  return false;
}

/**
 * Thread sets met so far, and the transitions between them. After
 * {@link MAX_CACHED_SETS} new sets it is emptied and rests for
 * {@link CACHE_REST} characters, on the plain simulation, then caches again:
 * a value that never repeats costs little sorting, and one whose sets settle
 * late is cached once they have.
 */
class ThreadSets {
  private ids = new Map<string, number>();
  private sets: Int32Array[] = [];
  private edges: Array<Map<number, number>> = [];
  private misses = 0;
  private resting = 0;

  /** The set's id, or -1 while the cache rests. */
  intern(list: Int32Array, count: number): number {
    if (this.resting > 0) {
      this.resting--;
      return -1;
    }
    const pcs = list.slice(0, count).sort();
    const key = pcs.join(",");
    let id = this.ids.get(key);
    if (id === undefined) {
      if (++this.misses > MAX_CACHED_SETS) {
        this.ids = new Map();
        this.sets = [];
        this.edges = [];
        this.misses = 0;
        this.resting = CACHE_REST;
        return -1;
      }
      id = this.sets.push(pcs) - 1;
      this.edges.push(new Map());
      this.ids.set(key, id);
    }
    return id;
  }

  target(from: number, key: number): number | undefined {
    return this.edges[from]!.get(key);
  }

  link(from: number, key: number, to: number): void {
    this.edges[from]!.set(key, to);
  }

  pcs(id: number): Int32Array {
    return this.sets[id]!;
  }
}

/** Distinct thread sets the cache holds before it is emptied. */
const MAX_CACHED_SETS = 256;
/** Characters the emptied cache rests for. */
const CACHE_REST = 1_024;

function isWord(cp: number): boolean {
  return ((cp >= 0x30 && cp <= 0x39) || (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a) || cp === 0x5f);
}

/** Program size, stopping early once past the cap. */
function size(node: Node): number {
  const cap = MAX_PATTERN_STATES + 1;
  switch (node.k) {
    case "lit":
    case "char":
    case "assert":
      return 1;
    case "seq":
      return Math.min(cap, node.items.reduce((sum, item) => Math.min(cap, sum + size(item)), 0));
    case "alt":
      return Math.min(cap, node.alts.reduce((sum, alt) => Math.min(cap, sum + size(alt)), 0) + 2 * (node.alts.length - 1));
    case "rep": {
      const one = size(node.node);
      const optional = node.max === Infinity ? one + 2 : (node.max - node.min) * (one + 1);
      return Math.min(cap, one * node.min + optional);
    }
  }
}

class Program {
  readonly op: number[] = [];
  readonly arg: number[] = [];
  readonly arg2: number[] = [];
  readonly cls: number[] = [];
  readonly tests: CharTest[] = [];
  private readonly ids = new Map<CharTest, number>();

  add(op: number, arg: number, arg2: number, test: CharTest | null): number {
    this.op.push(op);
    this.arg.push(arg);
    this.arg2.push(arg2);
    let id = -1;
    if (test) {
      id = this.ids.get(test) ?? this.tests.push(test) - 1;
      this.ids.set(test, id);
    }
    this.cls.push(id);
    return this.op.length - 1;
  }

  emit(node: Node): void {
    switch (node.k) {
      case "lit":
        this.add(LIT, node.cp, 0, null);
        return;
      case "char":
        this.add(CHAR, 0, 0, node.test);
        return;
      case "assert":
        this.add(ASSERT, node.kind, 0, null);
        return;
      case "seq":
        for (const item of node.items) this.emit(item);
        return;
      case "alt": {
        const jumps: number[] = [];
        node.alts.forEach((alt, i) => {
          const last = i === node.alts.length - 1;
          const split = last ? -1 : this.add(SPLIT, 0, 0, null);
          if (split >= 0) this.arg[split] = this.op.length;
          this.emit(alt);
          if (!last) {
            jumps.push(this.add(JMP, 0, 0, null));
            this.arg2[split] = this.op.length;
          }
        });
        for (const j of jumps) this.arg[j] = this.op.length;
        return;
      }
      case "rep": {
        for (let i = 0; i < node.min; i++) this.emit(node.node);
        if (node.max === Infinity) {
          const split = this.add(SPLIT, 0, 0, null);
          this.arg[split] = this.op.length;
          this.emit(node.node);
          this.add(JMP, split, 0, null);
          this.arg2[split] = this.op.length;
          return;
        }
        const splits: number[] = [];
        for (let i = node.min; i < node.max; i++) {
          const split = this.add(SPLIT, 0, 0, null);
          this.arg[split] = this.op.length;
          splits.push(split);
          this.emit(node.node);
        }
        for (const s of splits) this.arg2[s] = this.op.length;
        return;
      }
    }
  }
}

const LINE_TERMINATORS = new Set([0x0a, 0x0d, 0x2028, 0x2029]);
const DIGIT: CharTest = (cp) => cp >= 0x30 && cp <= 0x39;
const WORD: CharTest = (cp) => isWord(cp);
// One character against a native class is constant time, so it is safe to run natively.
const SPACE_RE = /^\s$/u;
const SPACE: CharTest = (cp) => SPACE_RE.test(String.fromCodePoint(cp));
const ANY: CharTest = (cp) => !LINE_TERMINATORS.has(cp);
const not =
  (test: CharTest): CharTest =>
  (cp) =>
    !test(cp);

const propertyTests = new Map<string, CharTest>();
function property(body: string, negated: boolean): CharTest {
  const key = `${negated ? "P" : "p"}{${body}}`;
  let test = propertyTests.get(key);
  if (!test) {
    const re = new RegExp(`^\\${key}$`, "u");
    test = (cp) => re.test(String.fromCodePoint(cp));
    if (propertyTests.size > 500) propertyTests.clear();
    propertyTests.set(key, test);
  }
  return test;
}

class Parser {
  private i = 0;

  constructor(private readonly src: string) {}

  parse(): Node {
    return this.disjunction();
  }

  private disjunction(): Node {
    const alts = [this.alternative()];
    while (this.src[this.i] === "|") {
      this.i++;
      alts.push(this.alternative());
    }
    return alts.length === 1 ? alts[0]! : { k: "alt", alts };
  }

  private alternative(): Node {
    const items: Node[] = [];
    while (this.i < this.src.length && this.src[this.i] !== "|" && this.src[this.i] !== ")") {
      const atom = this.atom();
      const q = this.quantifier();
      items.push(q ? { k: "rep", node: atom, min: q.min, max: q.max } : atom);
    }
    return items.length === 1 ? items[0]! : { k: "seq", items };
  }

  private quantifier(): { min: number; max: number } | null {
    const src = this.src;
    const ch = src[this.i];
    let q: { min: number; max: number } | null = null;
    if (ch === "*") q = { min: 0, max: Infinity };
    else if (ch === "+") q = { min: 1, max: Infinity };
    else if (ch === "?") q = { min: 0, max: 1 };
    if (q) this.i++;
    else if (ch === "{") {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(src.slice(this.i))!;
      this.i += m[0].length;
      const min = Number(m[1]);
      q = { min, max: m[2] === undefined ? min : m[3] === "" ? Infinity : Number(m[3]) };
      if (min > MAX_PATTERN_STATES || (q.max !== Infinity && q.max > MAX_PATTERN_STATES)) throw new Unsupported(`pattern is too large to match safely (a count above ${MAX_PATTERN_STATES})`);
    } else return null;
    if (src[this.i] === "?") this.i++;
    return q;
  }

  private atom(): Node {
    const src = this.src;
    const ch = src[this.i]!;
    if (ch === "^" || ch === "$") {
      this.i++;
      return { k: "assert", kind: ch === "^" ? START : END };
    }
    if (ch === "(") {
      if (src.startsWith("(?=", this.i) || src.startsWith("(?!", this.i)) throw new Unsupported("lookahead is not supported");
      if (src.startsWith("(?<=", this.i) || src.startsWith("(?<!", this.i)) throw new Unsupported("lookbehind is not supported");
      if (src.startsWith("(?:", this.i)) this.i += 3;
      else if (src.startsWith("(?<", this.i)) this.i = src.indexOf(">", this.i) + 1;
      else if (src.startsWith("(?", this.i)) throw new Unsupported("this kind of group is not supported");
      else this.i++;
      const inner = this.disjunction();
      this.i++; // ")"
      return inner;
    }
    if (ch === ".") {
      this.i++;
      return { k: "char", test: ANY };
    }
    if (ch === "[") return { k: "char", test: this.charClass() };
    if (ch === "\\") {
      const next = src[this.i + 1];
      if (next === "b" || next === "B") {
        this.i += 2;
        return { k: "assert", kind: next === "b" ? BOUNDARY : NOT_BOUNDARY };
      }
      if (next !== undefined && next >= "1" && next <= "9") throw new Unsupported("backreferences are not supported");
      if (next === "k") throw new Unsupported("backreferences are not supported");
      const cls = this.classEscape();
      if (cls) return { k: "char", test: cls };
      return { k: "lit", cp: this.charEscape() };
    }
    return { k: "lit", cp: this.literal() };
  }

  private literal(): number {
    const cp = this.src.codePointAt(this.i)!;
    this.i += cp > 0xffff ? 2 : 1;
    return cp;
  }

  /** `\d \D \w \W \s \S \p{…} \P{…}` at `i`, or null. */
  private classEscape(): CharTest | null {
    const src = this.src;
    const next = src[this.i + 1];
    let test: CharTest | null = null;
    if (next === "d" || next === "D") test = next === "d" ? DIGIT : not(DIGIT);
    else if (next === "w" || next === "W") test = next === "w" ? WORD : not(WORD);
    else if (next === "s" || next === "S") test = next === "s" ? SPACE : not(SPACE);
    else if (next === "p" || next === "P") {
      const close = src.indexOf("}", this.i);
      const t = property(src.slice(this.i + 3, close), next === "P");
      this.i = close + 1;
      return t;
    }
    if (test) this.i += 2;
    return test;
  }

  /** The code point of the escape at `i` (not a class escape). */
  private charEscape(inClass = false): number {
    const src = this.src;
    const next = src[this.i + 1]!;
    this.i += 2;
    switch (next) {
      case "t":
        return 0x09;
      case "n":
        return 0x0a;
      case "v":
        return 0x0b;
      case "f":
        return 0x0c;
      case "r":
        return 0x0d;
      case "0":
        return 0;
      case "b":
        if (inClass) return 0x08;
        break;
      case "c":
        return src.charCodeAt(this.i++) % 32;
      case "x": {
        const cp = parseInt(src.slice(this.i, this.i + 2), 16);
        this.i += 2;
        return cp;
      }
      case "u": {
        if (src[this.i] === "{") {
          const close = src.indexOf("}", this.i);
          const cp = parseInt(src.slice(this.i + 1, close), 16);
          this.i = close + 1;
          return cp;
        }
        const hi = parseInt(src.slice(this.i, this.i + 4), 16);
        this.i += 4;
        // A surrogate pair written as two escapes is one character.
        if (hi >= 0xd800 && hi <= 0xdbff && /^\\u[dD][c-fC-F][0-9a-fA-F]{2}$/.test(src.slice(this.i, this.i + 6))) {
          const lo = parseInt(src.slice(this.i + 2, this.i + 6), 16);
          this.i += 6;
          return (hi - 0xd800) * 0x400 + (lo - 0xdc00) + 0x10000;
        }
        return hi;
      }
    }
    // An identity escape: the character itself.
    this.i -= 1;
    return this.literal();
  }

  private charClass(): CharTest {
    const src = this.src;
    this.i++; // "["
    const negated = src[this.i] === "^";
    if (negated) this.i++;
    const ranges: number[] = [];
    const tests: CharTest[] = [];
    while (src[this.i] !== "]") {
      const first = this.classAtom();
      if (typeof first !== "number") {
        tests.push(first);
        continue;
      }
      if (src[this.i] === "-" && src[this.i + 1] !== "]") {
        this.i++;
        const last = this.classAtom() as number;
        ranges.push(first, last);
      } else ranges.push(first, first);
    }
    this.i++; // "]"
    const test: CharTest = (cp) => {
      for (let r = 0; r < ranges.length; r += 2) if (cp >= ranges[r]! && cp <= ranges[r + 1]!) return true;
      return tests.some((t) => t(cp));
    };
    return negated ? not(test) : test;
  }

  private classAtom(): number | CharTest {
    if (this.src[this.i] !== "\\") return this.literal();
    return this.classEscape() ?? this.charEscape(true);
  }
}
