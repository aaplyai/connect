import { describe, expect, it } from "vitest";
import { sqlDefinitionProblems } from "@aaply/connect";
import { scanStatement, statementProblem } from "../src/sql/statement.js";

describe("declared statements", () => {
  it("find placeholders and the first keyword outside quotes and comments", () => {
    const shape = scanStatement(`-- lead comment\n/* nested /* block */ */ SELECT '$9;', "a;b", E'it\\'s $8', $tag$ $7 ; $tag$, $1, $2 FROM t`);
    expect(shape).toEqual({ first: "select", placeholders: new Set([1, 2]) });
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
});
