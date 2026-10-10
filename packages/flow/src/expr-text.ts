/**
 * The text form of flow expressions, written in Facet's expression syntax.
 *
 *   {"expr": "fact.tripType == 'round' && fact.guests >= 1"}
 *   {"expr": "result.quote.total | default: 0"}
 *   {"expr": "fact.email | known"}
 *
 * The grammar is Facet's (FacetJS `packages/schema/src/expr` at 39c1095):
 * single-quoted strings with `\'` and `\\` escapes, numbers, `true`,
 * `false`, `null`, dotted paths, `!`, `== != < <= > >=`, `&&`, `||`,
 * `cond ? a : b`, parentheses and pipes (`input | name: arg, arg`, where an
 * argument is a literal or a path). So authors and agents write one syntax
 * in sections and in flows.
 *
 * Two things differ from Facet, by design:
 * - Paths start with the flow's scopes: `fact`, `result`, `payload`, `value`,
 *   `resource`, `env` and `item` (the element inside a JSON `map`, `filter`,
 *   `some` or `every`), plus the bare name `now`.
 * - Only pipes with a meaning in flows are accepted: `default`, `empty`,
 *   `length`, `lowercase`, `includes`, plus the flow pipes `trim`, `ms`,
 *   `known`, `failed` and `items` (a collection's rows as they stand, for
 *   views). Display pipes (formatDate, currency...) belong in sections.
 *
 * The text compiles to the JSON expression tree, which stays the canonical
 * form: the compiler stores and hashes the tree, never the text, and
 * evaluation is three-valued like every other flow expression. This
 * module is the one place to change if the grammar moves to a package shared
 * with Facet (see docs/adr/0001-expression-language.md).
 */

import type { Expr } from "./expr.js";
import type { PathSegment } from "./json.js";

export const MAX_EXPR_TEXT = 2000;

export type TextResult = { ok: true; expr: Expr } | { ok: false; message: string; offset: number };

type TokenKind = "op" | "string" | "number" | "identifier" | "end";

interface Token {
  kind: TokenKind;
  value: string;
  start: number;
  end: number;
}

class TextError extends Error {
  readonly offset: number;

  constructor(message: string, offset: number) {
    super(message);
    this.offset = offset;
  }
}

const OPERATORS = ["||", "&&", "==", "!=", "<=", ">=", "<", ">", "!", "?", ":", "|", ",", "(", ")", "."] as const;
const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_]/;
const DIGIT = /[0-9]/;
const SPACE = /\s/;
const MAX_DEPTH = 32;

/** `param` is valid only in fragments, where expansion replaces it (include.ts). */
const SCOPES = new Set(["fact", "result", "payload", "value", "resource", "env", "item", "now", "param"]);

const DISPLAY_PIPES = new Set(["uppercase", "capitalize", "truncate", "join", "formatDate", "formatNumber", "currency", "toggle"]);

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (SPACE.test(ch)) {
      i++;
      continue;
    }
    if (ch === "'") {
      const start = i;
      let value = "";
      i++;
      for (;;) {
        const c = src[i];
        if (c === undefined) throw new TextError("unterminated string literal", start);
        if (c === "'") {
          i++;
          break;
        }
        if (c === "\\") {
          const next = src[i + 1];
          if (next !== "'" && next !== "\\") throw new TextError("only \\' and \\\\ are valid escapes in a string literal", i);
          value += next;
          i += 2;
          continue;
        }
        value += c;
        i++;
      }
      out.push({ kind: "string", value, start, end: i });
      continue;
    }
    const prev = out[out.length - 1];
    const afterDot = prev?.kind === "op" && prev.value === ".";
    if (DIGIT.test(ch) || (!afterDot && ch === "-" && DIGIT.test(src[i + 1] ?? ""))) {
      const start = i;
      i++;
      while (DIGIT.test(src[i] ?? "")) i++;
      if (!afterDot && src[i] === "." && DIGIT.test(src[i + 1] ?? "")) {
        i++;
        while (DIGIT.test(src[i] ?? "")) i++;
      }
      out.push({ kind: "number", value: src.slice(start, i), start, end: i });
      continue;
    }
    if (IDENT_START.test(ch)) {
      const start = i;
      while (IDENT_PART.test(src[i] ?? "")) i++;
      out.push({ kind: "identifier", value: src.slice(start, i), start, end: i });
      continue;
    }
    const op = OPERATORS.find((o) => src.startsWith(o, i));
    if (op === undefined) throw new TextError(`unexpected character ${JSON.stringify(ch)}`, i);
    out.push({ kind: "op", value: op, start: i, end: i + op.length });
    i += op.length;
  }
  out.push({ kind: "end", value: "", start: src.length, end: src.length });
  return out;
}

/** A parsed path, kept apart from other expressions so pipes like `known` can see it. */
interface PathNode {
  scope: string;
  segments: PathSegment[];
  start: number;
}

type Parsed = { path: PathNode } | { expr: Expr };

const describe = (t: Token): string => (t.kind === "end" ? "the end of the expression" : `"${t.value}"`);

class Parser {
  private index = 0;
  private depth = 0;

  constructor(private readonly tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.index] ?? this.tokens[this.tokens.length - 1]!;
  }

  private isOp(value: string): boolean {
    const t = this.peek();
    return t.kind === "op" && t.value === value;
  }

  private take(): Token {
    const t = this.peek();
    this.index++;
    return t;
  }

  private expectOp(value: string): void {
    const t = this.peek();
    if (t.kind !== "op" || t.value !== value) throw new TextError(`expected "${value}" but found ${describe(t)}`, t.start);
    this.take();
  }

  expectEnd(): void {
    const t = this.peek();
    if (t.kind !== "end") throw new TextError(`unexpected ${describe(t)}`, t.start);
  }

  private descend<T>(parse: () => T): T {
    if (this.depth >= MAX_DEPTH) throw new TextError("expression nesting exceeds the depth limit", this.peek().start);
    this.depth++;
    try {
      return parse();
    } finally {
      this.depth--;
    }
  }

  parseExpression(): Expr {
    return this.parseTernary();
  }

  private parseTernary(): Expr {
    const test = this.parseOr();
    if (!this.isOp("?")) return test;
    this.take();
    const then = this.descend(() => this.parseTernary());
    this.expectOp(":");
    const otherwise = this.descend(() => this.parseTernary());
    return { if: [test, then, otherwise] };
  }

  private parseOr(): Expr {
    const items = [this.parseAnd()];
    while (this.isOp("||")) {
      this.take();
      items.push(this.parseAnd());
    }
    return items.length === 1 ? items[0]! : { or: items };
  }

  private parseAnd(): Expr {
    const items = [this.parseEquality()];
    while (this.isOp("&&")) {
      this.take();
      items.push(this.parseEquality());
    }
    return items.length === 1 ? items[0]! : { and: items };
  }

  private parseEquality(): Expr {
    let left = this.parseRelational();
    for (;;) {
      const t = this.peek();
      if (t.kind !== "op" || (t.value !== "==" && t.value !== "!=")) return left;
      this.take();
      const right = this.parseRelational();
      left = t.value === "==" ? { eq: [left, right] } : { ne: [left, right] };
    }
  }

  private parseRelational(): Expr {
    let left = this.parseUnary();
    for (;;) {
      const t = this.peek();
      const op = t.kind === "op" ? ({ "<": "lt", "<=": "lte", ">": "gt", ">=": "gte" } as const)[t.value as "<"] : undefined;
      if (op === undefined) return left;
      this.take();
      const right = this.parseUnary();
      left = { [op]: [left, right] } as Expr;
    }
  }

  private parseUnary(): Expr {
    if (this.isOp("!")) {
      this.take();
      return { not: this.descend(() => this.parseUnary()) };
    }
    return this.parsePiped();
  }

  private parsePiped(): Expr {
    let input: Parsed = this.parsePrimary();
    while (this.isOp("|")) {
      this.take();
      const name = this.peek();
      if (name.kind !== "identifier") throw new TextError(`expected a pipe name but found ${describe(name)}`, name.start);
      this.take();
      const args: Expr[] = [];
      if (this.isOp(":")) {
        this.take();
        args.push(this.parsePipeArg());
        while (this.isOp(",")) {
          this.take();
          args.push(this.parsePipeArg());
        }
      }
      input = { expr: applyPipe(input, name, args) };
    }
    return toExpr(input);
  }

  private parsePipeArg(): Expr {
    const t = this.peek();
    if (t.kind === "string" || t.kind === "number") return this.literal();
    if (t.kind === "identifier") {
      if (t.value === "true" || t.value === "false" || t.value === "null") return this.literal();
      return toExpr({ path: this.parsePath() });
    }
    throw new TextError(`expected a literal or a path as pipe argument but found ${describe(t)}`, t.start);
  }

  private parsePrimary(): Parsed {
    const t = this.peek();
    if (t.kind === "string" || t.kind === "number") return { expr: this.literal() };
    if (t.kind === "identifier") {
      if (t.value === "true" || t.value === "false" || t.value === "null") return { expr: this.literal() };
      return { path: this.parsePath() };
    }
    if (t.kind === "op" && t.value === "(") {
      this.take();
      const inner = this.descend(() => this.parseExpression());
      this.expectOp(")");
      return { expr: inner };
    }
    throw new TextError(`expected a value but found ${describe(t)}`, t.start);
  }

  private literal(): Expr {
    const t = this.take();
    if (t.kind === "string") return t.value;
    if (t.kind === "number") {
      const value = Number(t.value);
      if (!Number.isFinite(value)) throw new TextError("numeric literals must be finite", t.start);
      return value;
    }
    if (t.value === "true") return true;
    if (t.value === "false") return false;
    return null;
  }

  private parsePath(): PathNode {
    const head = this.take();
    if (!SCOPES.has(head.value)) {
      throw new TextError(`unknown scope "${head.value}"; paths start with fact, result, payload, value, resource, env, item or now`, head.start);
    }
    const segments: PathSegment[] = [];
    while (this.isOp(".")) {
      const dot = this.take();
      const seg = this.peek();
      if (seg.kind === "identifier") segments.push(seg.value);
      else if (seg.kind === "number" && /^[0-9]+$/.test(seg.value)) segments.push(Number(seg.value));
      else throw new TextError(`expected a path segment after "." but found ${describe(seg)}`, dot.end);
      this.take();
    }
    return { scope: head.value, segments, start: head.start };
  }
}

function toExpr(p: Parsed): Expr {
  if ("expr" in p) return p.expr;
  const { scope, segments, start } = p.path;
  const named = (kind: "fact" | "result"): Expr => {
    const [name, ...rest] = segments;
    if (typeof name !== "string") throw new TextError(`${kind} needs a name, as in ${kind}.${kind === "fact" ? "email" : "quote"}`, start);
    return (rest.length > 0 ? { [kind]: name, path: rest } : { [kind]: name }) as Expr;
  };
  switch (scope) {
    case "fact":
    case "result":
      return named(scope);
    case "payload":
      return { payload: segments };
    case "value":
      return { value: segments };
    case "resource":
      return { resource: segments };
    case "item":
      return { item: segments };
    case "param": {
      const name = segments[0];
      if (segments.length !== 1 || typeof name !== "string") throw new TextError("param is param.name", start);
      return { param: name };
    }
    case "env": {
      const name = segments[0];
      if (segments.length !== 1 || (name !== "locale" && name !== "timezone" && name !== "environment")) {
        throw new TextError("env is env.locale, env.timezone or env.environment", start);
      }
      return { env: name };
    }
    default:
      if (segments.length > 0) throw new TextError("now has no fields", start);
      return { now: true };
  }
}

function applyPipe(input: Parsed, name: Token, args: Expr[]): Expr {
  const arity = (n: number) => {
    if (args.length !== n) throw new TextError(`pipe "${name.value}" takes ${n === 0 ? "no arguments" : `${n} argument`}`, name.start);
  };
  const bareName = (kind: "fact" | "result"): string => {
    if (!("path" in input) || input.path.scope !== kind || input.path.segments.length !== 1 || typeof input.path.segments[0] !== "string") {
      throw new TextError(`pipe "${name.value}" applies to a ${kind} name, as in ${kind}.${kind === "fact" ? "email" : "quote"} | ${name.value}`, name.start);
    }
    return input.path.segments[0];
  };
  switch (name.value) {
    case "default":
      arity(1);
      return { coalesce: [toExpr(input), args[0]!] };
    case "empty": {
      arity(0);
      const value = toExpr(input);
      return { or: [{ eq: [value, null] }, { eq: [{ len: value }, 0] }] };
    }
    case "length":
      arity(0);
      return { len: toExpr(input) };
    case "lowercase":
      arity(0);
      return { lower: toExpr(input) };
    case "trim":
      arity(0);
      return { trim: toExpr(input) };
    case "ms":
      arity(0);
      return { ms: toExpr(input) };
    case "includes":
      arity(1);
      return { in: [args[0]!, toExpr(input)] };
    case "known":
      arity(0);
      return { known: bareName("fact") };
    case "failed":
      arity(0);
      return { failed: bareName("result") };
    case "items":
      arity(0);
      return { items: bareName("fact") };
    default:
      if (DISPLAY_PIPES.has(name.value)) throw new TextError(`pipe "${name.value}" formats for display; use it in the section, not the flow`, name.start);
      throw new TextError(`unknown pipe "${name.value}"`, name.start);
  }
}

/** Compiles the text form to a JSON expression, or explains where it fails. */
export function textToExpr(src: string): TextResult {
  if (src.length > MAX_EXPR_TEXT) return { ok: false, message: `expression text is longer than ${MAX_EXPR_TEXT} characters`, offset: 0 };
  try {
    const parser = new Parser(tokenize(src));
    const expr = parser.parseExpression();
    parser.expectEnd();
    return { ok: true, expr };
  } catch (error) {
    if (error instanceof TextError) return { ok: false, message: error.message, offset: error.offset };
    throw error;
  }
}
