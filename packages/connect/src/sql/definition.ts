/**
 * Declared SQL connectors: data, not code. A definition is stored per scope
 * as an installation, validated here, and pinned by digest; each
 * operation's statement digest is its `implementation`, so a flow pinned to
 * an operation covers its exact SQL.
 *
 * ```json
 * { "id": "booking-db", "version": "1.0.0", "title": "Booking database", "kind": "sql", "engine": "postgres",
 *   "operations": { "createBooking": {
 *     "title": "Create a booking", "effect": "write", "idempotent": true, "riskFloor": "confirm",
 *     "statement": "insert into booking.bookings (slot_id, reference) values ($1, $2) on conflict (reference) do nothing returning id",
 *     "params": ["slotId", "reference"], "rows": "one",
 *     "onConflictEmpty": { "statement": "select id from booking.bookings where reference = $1 and slot_id = $2", "params": ["reference", "slotId"] },
 *     "errors": { "23P01": "booking/slot-taken" },
 *     "input": { ... }, "output": { ... } } } }
 * ```
 *
 * Rows: `one` answers the row; `optional` answers `{ row }` (null when
 * none); `many` answers `{ rows }` (at most `maxRows`, default 100);
 * `none` answers `{ rowCount }`.
 */

import { sha256Digest, type JsonObject, type JsonSchema, type JsonValue, type Risk, type Sha256Digest } from "@aaply/action-contract";
import { statementProblem } from "./statement.js";

export type SqlRows = "one" | "optional" | "many" | "none";

export interface SqlStatement {
  statement: string;
  /** Input property names, in placeholder order (`$1` is the first). */
  params: string[];
}

export interface SqlOperation extends SqlStatement {
  title: string;
  description?: string;
  effect: "read" | "write";
  idempotent?: boolean;
  compensate?: string;
  irreversible?: boolean;
  riskFloor?: Risk;
  rows: SqlRows;
  /** For `many`: the most rows answered. Default 100, at most 1,000. */
  maxRows?: number;
  /**
   * For an `insert … on conflict do nothing returning …` that de-duplicates
   * on a business reference: run when the insert returns no row, to read the
   * existing one. It must find it with the same other values, or the call
   * fails with `sql/reference-reused`.
   */
  onConflictEmpty?: SqlStatement;
  /** SQLSTATE → the error code answered (final), for constraint errors the flow handles. */
  errors?: Record<string, string>;
  input: JsonSchema;
  output: JsonSchema;
}

export interface SqlConnectorDefinition {
  id: string;
  version: string;
  title: string;
  kind: "sql";
  engine: "postgres";
  operations: Record<string, SqlOperation>;
}

export const MAX_SQL_ROWS = 1_000;
const ID = /^[a-z][a-z0-9-]{0,62}$/;
const OP = /^[A-Za-z][A-Za-z0-9_]{0,62}$/;
const CODE = /^[a-z][a-z0-9-]{0,30}\/[a-z0-9][a-z0-9-]{0,62}$/;
const OP_KEYS = new Set(["title", "description", "effect", "idempotent", "compensate", "irreversible", "riskFloor", "statement", "params", "rows", "maxRows", "onConflictEmpty", "errors", "input", "output"]);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function paramsProblem(params: unknown, input: Record<string, unknown>): string | null {
  if (!Array.isArray(params) || params.length > 100 || !params.every((p) => typeof p === "string")) return "params is a list of input property names";
  const properties = isObject(input.properties) ? input.properties : {};
  for (const p of params) if (!Object.prototype.hasOwnProperty.call(properties, p)) return `param ${p} is not a property of the input`;
  return null;
}

/** Every problem with a SQL connector definition (empty when it can be installed). The kit checks the rest when it is built. */
export function sqlDefinitionProblems(value: unknown): string[] {
  const out: string[] = [];
  if (!isObject(value)) return ["a SQL connector definition is an object"];
  const d = value;
  if (typeof d.id !== "string" || !ID.test(d.id)) out.push("id is 1-63 lower-case letters, digits and '-', starting with a letter");
  if (typeof d.version !== "string" || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(d.version)) out.push("version is a semantic version");
  if (typeof d.title !== "string" || d.title.length === 0 || d.title.length > 200) out.push("title is 1-200 characters");
  if (d.kind !== "sql") out.push('kind is "sql"');
  if (d.engine !== "postgres") out.push('engine is "postgres"');
  if (!isObject(d.operations) || Object.keys(d.operations).length === 0) return [...out, "operations names at least one operation"];
  for (const [name, raw] of Object.entries(d.operations)) {
    const at = `operations.${name}`;
    if (!OP.test(name)) out.push(`${at}: an operation name is letters, digits and '_'`);
    if (!isObject(raw)) {
      out.push(`${at} is an object`);
      continue;
    }
    for (const k of Object.keys(raw)) if (!OP_KEYS.has(k)) out.push(`${at}: unknown field ${k}`);
    const effect = raw.effect;
    if (effect !== "read" && effect !== "write") {
      out.push(`${at}.effect is read or write`);
      continue;
    }
    const input = isObject(raw.input) ? raw.input : {};
    const params = paramsProblem(raw.params, input);
    if (params) out.push(`${at}: ${params}`);
    else {
      const problem = statementProblem(raw.statement as string, effect, (raw.params as string[]).length);
      if (problem) out.push(`${at}.statement: ${problem}`);
    }
    if (!["one", "optional", "many", "none"].includes(raw.rows as string)) out.push(`${at}.rows is one, optional, many or none`);
    if (raw.maxRows !== undefined && (raw.rows !== "many" || !Number.isInteger(raw.maxRows) || (raw.maxRows as number) < 1 || (raw.maxRows as number) > MAX_SQL_ROWS)) {
      out.push(`${at}.maxRows is for rows "many", from 1 to ${MAX_SQL_ROWS}`);
    }
    if (raw.onConflictEmpty !== undefined) {
      const o = raw.onConflictEmpty;
      if (effect !== "write" || raw.rows !== "one" || !isObject(o)) out.push(`${at}.onConflictEmpty is for a write with rows "one", as { statement, params }`);
      else {
        const p = paramsProblem(o.params, input);
        if (p) out.push(`${at}.onConflictEmpty: ${p}`);
        else {
          const problem = statementProblem(o.statement as string, "read", (o.params as string[]).length);
          if (problem) out.push(`${at}.onConflictEmpty.statement: ${problem}`);
        }
      }
    }
    if (raw.errors !== undefined) {
      if (!isObject(raw.errors)) out.push(`${at}.errors maps SQLSTATE to an error code`);
      else
        for (const [state, code] of Object.entries(raw.errors)) {
          if (!/^[0-9A-Z]{5}$/.test(state)) out.push(`${at}.errors: ${state} is not a SQLSTATE`);
          if (typeof code !== "string" || !CODE.test(code) || code.startsWith("connect/") || code.startsWith("flow/")) out.push(`${at}.errors.${state}: a code is <domain>/<name>, not connect/ or flow/`);
        }
    }
  }
  return out;
}

/** The digest of what an operation runs: its statements, row rule and error table. */
export function implementationDigest(engine: string, op: SqlOperation): Sha256Digest {
  const body: JsonObject = {
    sqlImplementation: 1,
    engine,
    statement: op.statement,
    params: op.params,
    rows: op.rows,
    maxRows: op.maxRows ?? null,
    onConflictEmpty: op.onConflictEmpty ? { statement: op.onConflictEmpty.statement, params: op.onConflictEmpty.params } : null,
    errors: op.errors ?? {},
  };
  return sha256Digest(body);
}

/** The digest an installation is pinned by: the whole definition. */
export function definitionDigest(definition: SqlConnectorDefinition): Sha256Digest {
  return sha256Digest(definition as unknown as JsonValue);
}
