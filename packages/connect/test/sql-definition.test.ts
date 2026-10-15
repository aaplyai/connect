import { describe, expect, it } from "vitest";
import { CONFORMANCE_AUDIENCE, conformanceVerifier, draftApprovedAction } from "@aaply/action-contract/conformance";
import { createConnectorActionPort, memoryReplayGuard, operationContractOf } from "@aaply/connector-sdk";
import { sqlDefinitionProblems, type SqlConnectorDefinition } from "@aaply/connect";
import { sqlConnector } from "../src/sql/connector.js";
import { scanStatement, statementProblem } from "../src/sql/statement.js";

describe("declared statements", () => {
  it("find placeholders and the first keyword outside quotes and comments", () => {
    const shape = scanStatement(`-- lead comment\n/* nested /* block */ */ SELECT '$9;', "a;b", E'it\\'s $8', $tag$ $7 ; $tag$, $1, $2 FROM t`);
    expect(shape).toEqual({ first: "select", placeholders: new Set([1, 2]) });
  });

  it("allow one trailing ';'", () => {
    expect(statementProblem("select 1;", "read", 0)).toBeNull();
    expect(statementProblem("select 1; -- done\n", "read", 0)).toBeNull();
    expect(statementProblem("select 1;;", "read", 0)).toMatch(/';'/);
    expect(statementProblem("select 1; /* a */ delete from t /* b */", "read", 0)).toMatch(/';'/);
    // Linear, whatever follows the ';'.
    const started = Date.now();
    expect(statementProblem(`select 1;${"/**/ ".repeat(3_000)}x`, "read", 0)).toMatch(/';'/);
    expect(Date.now() - started).toBeLessThan(200);
  });

  it("refuse a second statement, unclosed quoting, an empty statement and wrong first keywords", () => {
    expect(statementProblem("select 1; delete from t", "read", 0)).toMatch(/';'/);
    expect(statementProblem("select 'x", "read", 0)).toMatch(/not closed/);
    expect(statementProblem("select $q$ x", "read", 0)).toMatch(/not closed/);
    expect(statementProblem("/* x", "read", 0)).toMatch(/not closed/);
    expect(statementProblem("-- only a comment", "read", 0)).toMatch(/empty/);
    for (const s of ["delete from t", "copy t to stdout", "do $$ begin end $$", "set role x", "call p()", "drop table t", "begin"]) expect(statementProblem(s, "read", 0), s).toMatch(/starts with/);
    for (const s of ["select 1", "copy t from stdin", "truncate t", "grant all on t to x"]) expect(statementProblem(s, "write", 0), s).toMatch(/starts with/);
    expect(statementProblem("with d as (delete from t returning *) select * from d", "write", 0)).toBeNull();
  });

  it("match placeholders to params exactly", () => {
    expect(statementProblem("select $1, $3", "read", 3)).toMatch(/\$2 is never used/);
    expect(statementProblem("select $1, $2", "read", 1)).toMatch(/\$2 has no parameter/);
    expect(statementProblem("select $1, $1", "read", 1)).toBeNull();
  });
});

describe("SQL connector definitions", () => {
  const ok = {
    id: "booking-db",
    version: "1.0.0",
    title: "Bookings",
    kind: "sql",
    engine: "postgres",
    operations: {
      find: { title: "Find", effect: "read", statement: "select id from t where id = $1", params: ["id"], rows: "optional", input: { type: "object", properties: { id: { type: "string" } } }, output: { type: "object" } },
    },
  };

  it("accept a valid definition", () => {
    expect(sqlDefinitionProblems(ok)).toEqual([]);
  });

  it("name every problem", () => {
    const bad = {
      ...ok,
      id: "Booking DB",
      engine: "mysql",
      operations: {
        find: { ...ok.operations.find, params: ["missing"], rows: "all", errors: { "23505": "connect/oops", bad: "x/y" }, extra: true },
        put: { title: "Put", effect: "write", statement: "insert into t values ($1)", params: ["v"], rows: "many", maxRows: 5000, onConflictEmpty: { statement: "select 1", params: [] }, input: { type: "object", properties: { v: {} } }, output: {} },
      },
    };
    const problems = sqlDefinitionProblems(bad).join("\n");
    for (const expected of ["id is", 'engine is "postgres"', "unknown field extra", "param missing", "rows is one", "not a SQLSTATE", "not connect/ or flow/", "maxRows", "onConflictEmpty is for a write with rows \"one\""]) {
      expect(problems).toContain(expected);
    }
  });

  it("refuse a lookup by an optional value, errors outside the refusal classes, and an oversized definition", () => {
    const put = {
      title: "Put",
      effect: "write",
      statement: "insert into t (ref, note) values ($1, $2) on conflict do nothing returning ref",
      params: ["ref", "note"],
      rows: "one",
      onConflictEmpty: { statement: "select ref from t where ref = $1 and note = $2", params: ["ref", "note"] },
      errors: { "57P01": "x/shutdown" },
      input: { type: "object", required: ["ref"], properties: { ref: { type: "string" }, note: { type: "string" } } },
      output: { type: "object" },
    };
    const problems = sqlDefinitionProblems({ ...ok, operations: { put } }).join("\n");
    expect(problems).toContain("param note must be required");
    expect(problems).toContain("class 23, 22 or P0");
    const many = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`op${i}`, ok.operations.find]));
    expect(sqlDefinitionProblems({ ...ok, operations: many }).join("\n")).toContain("at most 100 operations");
  });
});

describe("an undo-only SQL operation", () => {
  const definition = (undoOnly?: boolean): SqlConnectorDefinition => ({
    id: "holds-db",
    version: "1.0.0",
    title: "Holds",
    kind: "sql",
    engine: "postgres",
    operations: {
      hold: {
        title: "Hold",
        effect: "write",
        idempotent: true,
        compensate: "release",
        statement: "insert into h (ref) values ($1) on conflict (ref) do nothing returning id",
        params: ["ref"],
        rows: "one",
        onConflictEmpty: { statement: "select id from h where ref = $1", params: ["ref"] },
        input: { type: "object", required: ["ref"], properties: { ref: { type: "string" } } },
        output: { type: "object", required: ["id"], properties: { id: { type: "integer" } } },
      },
      release: {
        title: "Release",
        effect: "write",
        idempotent: true,
        ...(undoOnly !== undefined ? { undoOnly } : {}),
        statement: "delete from h where id = $1 returning id",
        params: ["id"],
        rows: "one",
        input: { type: "object", required: ["id"], properties: { id: { type: "integer" } } },
        output: { type: "object" },
      },
    },
  });

  it("is declared with undoOnly, carried into its contract, and refused as a step without running its statement", async () => {
    expect(sqlDefinitionProblems(definition(true))).toEqual([]);
    let ran = 0;
    const executor = { run: async () => (ran++, { id: 1 }), close: async () => {} };
    const connection = async () => ({ tenantId: "t", poolKey: "p", target: {} as never, password: "pw", deadline: Date.now() + 10_000, onCommit() {}, onRolledBack() {} });
    const step = draftApprovedAction({ action: "holds-db.release", effect: "write", input: { id: 1 }, idempotent: true, now: Date.now(), role: null, subject: null });
    const perform = (undoOnly?: boolean) => {
      const connector = sqlConnector(definition(undoOnly), executor, connection);
      const port = createConnectorActionPort({ audience: CONFORMANCE_AUDIENCE, verifier: conformanceVerifier(), replayGuard: memoryReplayGuard(), connectors: [connector], connections: () => ({ connectionId: "c", grantedScopes: [], subjectId: null }), credentials: { headers: () => ({}) } });
      return { contract: operationContractOf(connector, "release"), outcome: port.run(step) };
    };

    const marked = perform(true);
    expect(marked.contract?.undoOnly).toBe(true);
    expect(await marked.outcome).toMatchObject({ status: "final", error: { code: "connect/effect-mismatch" } });
    expect(ran).toBe(0);
    // Unmarked, the same envelope runs the statement: the refusal above is the marker's.
    const unmarked = perform(undefined);
    expect(unmarked.contract).not.toHaveProperty("undoOnly");
    expect(await unmarked.outcome).toMatchObject({ status: "ok" });
    expect(ran).toBe(1);
  });

  it("refuses an undoOnly that is not a boolean, when it is built", () => {
    const bad = definition();
    (bad.operations.release as unknown as Record<string, unknown>).undoOnly = "yes";
    const executor = { run: async () => ({}), close: async () => {} };
    expect(() => sqlConnector(bad, executor, async () => ({}) as never)).toThrow(/undoOnly/);
  });
});
