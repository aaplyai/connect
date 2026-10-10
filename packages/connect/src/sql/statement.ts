/**
 * The checks a declared SQL statement passes before it is installed: one
 * statement, starting with a keyword its effect allows, its `$n`
 * placeholders exactly `$1` to `$params.length`. The scan knows PostgreSQL's
 * quoting (strings, `E''` strings, quoted identifiers, dollar quotes) and
 * comments (nested block comments), so a `;` or `$1` inside them is text.
 *
 * These checks keep mistakes out at install; they are not the boundary.
 * The executor sends every statement with the extended protocol, which runs
 * exactly one command, with `standard_conforming_strings` on, and reads in a
 * READ ONLY transaction, so the database itself refuses stacking and most
 * hidden writes. (READ ONLY still allows side effects that are not table
 * writes, such as dblink, pg_notify or advisory locks: give a read
 * connection a database role that can only read.)
 */

const READ_STARTS = new Set(["select", "with", "values", "table"]);
const WRITE_STARTS = new Set(["insert", "update", "delete", "with"]);

export interface StatementShape {
  /** The first keyword, lower case. */
  first: string;
  /** Every placeholder number used. */
  placeholders: Set<number>;
}

/** Scans a statement; answers its shape, or what is wrong with it. */
export function scanStatement(text: string): StatementShape | string {
  const placeholders = new Set<number>();
  let first = "";
  let i = 0;
  let ended = false;
  const n = text.length;
  while (i < n) {
    const c = text[i]!;
    const next = text[i + 1];
    // After a ';' only space and comments may follow: anything else would be a second statement.
    if (ended && !/\s/.test(c) && !(c === "-" && next === "-") && !(c === "/" && next === "*")) return "a statement may not contain ';': one statement per operation";
    if (c === "-" && next === "-") {
      const end = text.indexOf("\n", i);
      i = end === -1 ? n : end + 1;
    } else if (c === "/" && next === "*") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (text[i] === "/" && text[i + 1] === "*") (depth++, (i += 2));
        else if (text[i] === "*" && text[i + 1] === "/") (depth--, (i += 2));
        else i++;
      }
      if (depth > 0) return "a block comment is not closed";
    } else if (c === "'" || ((c === "E" || c === "e") && next === "'" && !/[A-Za-z0-9_]/.test(text[i - 1] ?? ""))) {
      const escapes = c !== "'";
      i += escapes ? 2 : 1;
      let closed = false;
      while (i < n) {
        if (escapes && text[i] === "\\") i += 2;
        else if (text[i] === "'" && text[i + 1] === "'") i += 2;
        else if (text[i] === "'") {
          i++;
          closed = true;
          break;
        } else i++;
      }
      if (!closed) return "a string is not closed";
    } else if (c === '"') {
      const end = text.indexOf('"', i + 1);
      if (end === -1) return "a quoted identifier is not closed";
      i = end + 1;
    } else if (c === "$" && next !== undefined && /[0-9]/.test(next)) {
      let j = i + 1;
      while (j < n && /[0-9]/.test(text[j]!)) j++;
      placeholders.add(Number(text.slice(i + 1, j)));
      i = j;
    } else if (c === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i));
      if (!m || /[A-Za-z0-9_]/.test(text[i - 1] ?? "")) {
        i++;
        continue;
      }
      const end = text.indexOf(m[0], i + m[0].length);
      if (end === -1) return "a dollar-quoted string is not closed";
      i = end + m[0].length;
    } else if (c === ";") {
      // A trailing ';' is allowed; the check above refuses anything but space and comments after it.
      ended = true;
      i++;
    } else if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$]/.test(text[j]!)) j++;
      if (first === "") first = text.slice(i, j).toLowerCase();
      i = j;
    } else {
      i++;
    }
  }
  if (first === "") return "the statement is empty";
  return { first, placeholders };
}

/** What is wrong with `text` as the statement of an operation of `effect` taking `params`, or null. */
export function statementProblem(text: string, effect: "read" | "write", paramCount: number): string | null {
  if (typeof text !== "string" || text.length === 0 || text.length > 20_000) return "a statement is 1 to 20,000 characters";
  const shape = scanStatement(text);
  if (typeof shape === "string") return shape;
  const allowed = effect === "read" ? READ_STARTS : WRITE_STARTS;
  if (!allowed.has(shape.first)) return `a ${effect} statement starts with ${[...allowed].join(", ")}, not ${shape.first}`;
  for (const p of shape.placeholders) if (p < 1 || p > paramCount) return `$${p} has no parameter (params lists ${paramCount})`;
  for (let p = 1; p <= paramCount; p++) if (!shape.placeholders.has(p)) return `$${p} is never used`;
  return null;
}
