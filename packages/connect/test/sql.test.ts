import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { operationDigest, signApprovedAction, type ApprovedAction, type ApprovedActionSigner, type Scope } from "@aaply/action-contract";
import { CONFORMANCE_SCOPE, draftApprovedAction, type ApprovedActionDraft } from "@aaply/action-contract/conformance";
import { createConnect, type Connect } from "@aaply/connect";
import { postgresUnavailable, startTestDatabase, testEngineKeys, testKeyProvider, type TestDatabase } from "@aaply/connect/testing";
import { BOOKING_SCHEMA, bookingConnector } from "./booking.js";

const AUDIENCE = "connect.test";
const scope: Scope = CONFORMANCE_SCOPE;
const keys = testKeyProvider();

describe.skipIf(postgresUnavailable())("declared SQL connectors", () => {
  let db: TestDatabase;
  let engine: { signer: ApprovedActionSigner; engineKeys: Record<string, string> };
  let connect: Connect;
  let seq = 0;

  const sign = (draft: Omit<ApprovedActionDraft, "now" | "audience" | "key">): Promise<ApprovedAction> => {
    const { proof: _p, ...unsigned } = draftApprovedAction({ scope, effectId: `e-${++seq}`, ...draft, now: Date.now(), audience: AUDIENCE, key: null });
    return signApprovedAction<ApprovedAction>(unsigned, engine.signer);
  };
  const book = (input: Record<string, string>, extra: Partial<ApprovedActionDraft> = {}) =>
    sign({ action: "booking-db.createBooking", effect: "write", input, idempotent: true, risk: "confirm", ...extra });

  beforeAll(async () => {
    db = await startTestDatabase({ tcp: true });
    engine = await testEngineKeys();
    const admin = db.pool("postgres", "postgres");
    await admin.query("CREATE DATABASE booking");
    await db.pool("postgres", "booking").query(BOOKING_SCHEMA);
    connect = await createConnect({ audience: AUDIENCE, engineKeys: engine.engineKeys, connectors: [], pool: db.app, keys, egress: { allowPrivate: ["127.0.0.1/32"], sqlPrivateTenants: [scope.tenantId] } });
    await connect.admin.installSql(scope, bookingConnector());
    await connect.admin.createConnection({
      scope,
      connectorId: "booking-db",
      owner: { business: true },
      config: { host: "127.0.0.1", port: db.port, database: "booking", user: "booking_app", tls: "disable" },
      secret: { password: "booking-pw" },
    });
  });
  afterAll(async () => {
    await connect?.close();
    await db?.close();
  });

  it("reads rows", async () => {
    const outcome = await connect.perform(await sign({ action: "booking-db.freeSlots", effect: "read", input: {} }));
    expect(outcome).toMatchObject({ status: "ok", output: { rows: [{ id: "s1", starts_at: "2026-11-02T09:00:00.000Z" }, { id: "s2" }, { id: "s3" }] } });
  });

  it("books once by business reference, however often the write is sent", async () => {
    const input = { slotId: "s1", customerRef: "ana", reference: "ref-ana-0001" };
    const first = await connect.perform(await book(input));
    expect(first).toMatchObject({ status: "ok", output: { status: "booked" } });
    const again = await connect.perform(await book(input, { attempt: 2 }));
    expect(again).toEqual(first);
    const { rows } = await db.pool("postgres", "booking").query("SELECT count(*)::int AS n FROM booking.bookings WHERE reference = 'ref-ana-0001'");
    expect(rows[0].n).toBe(1);
  });

  it("answers the declared error for a taken slot, and refuses a reference reused with other details", async () => {
    expect(await connect.perform(await book({ slotId: "s1", customerRef: "bo", reference: "ref-bo-00001" }))).toMatchObject({ status: "final", error: { code: "booking/slot-taken" } });
    expect(await connect.perform(await book({ slotId: "s2", customerRef: "ana", reference: "ref-ana-0001" }))).toMatchObject({ status: "final", error: { code: "sql/reference-reused" } });
    expect(await connect.perform(await book({ slotId: "s9", customerRef: "cy", reference: "ref-cy-00001" }))).toMatchObject({ status: "final", error: { code: "booking/no-such-slot" } });
  });

  it("runs the declared undo, unreviewed, as the engine sends it", async () => {
    const input = { slotId: "s2", customerRef: "dee", reference: "ref-dee-0001" };
    const booked = await connect.perform(await book(input, { effectId: "booking-dee" }));
    expect(booked.status).toBe("ok");
    const undo = await sign({ action: "booking-db.cancelBooking", effect: "write", input, idempotent: true, purpose: "compensate", target: "booking-dee", undoes: "booking-db.createBooking" });
    expect(await connect.perform(undo)).toMatchObject({ status: "ok", output: { status: "cancelled" } });
    // The slot is free again.
    expect(await connect.perform(await book({ slotId: "s2", customerRef: "eve", reference: "ref-eve-0001" }))).toMatchObject({ status: "ok" });
  });

  it("runs reads in a read-only transaction, so a write hidden in a read is refused by the database", async () => {
    expect(await connect.perform(await sign({ action: "booking-db.sneakyRead", effect: "read", input: {} }))).toMatchObject({ status: "final", error: { code: "sql/read-only" } });
    const { rows } = await db.pool("postgres", "booking").query("SELECT count(*)::int AS n FROM booking.bookings WHERE status = 'gone'");
    expect(rows[0].n).toBe(0);
  });

  it("stops a statement at the call's budget and answers retryable", async () => {
    const started = Date.now();
    const outcome = await connect.perform(await sign({ action: "booking-db.slow", effect: "read", input: {}, timeoutMs: 3_500 }));
    expect(outcome).toMatchObject({ status: "retryable" });
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("pins the exact SQL: a run pinned to a replaced statement is served by it, until four newer ones push it out", async () => {
    const s = { ...scope, appId: "pins" };
    await connect.admin.installSql(s, bookingConnector());
    await connect.admin.createConnection({ scope: s, connectorId: "booking-db", owner: { business: true }, config: { host: "127.0.0.1", port: db.port, database: "booking", user: "booking_app", tls: "disable" }, secret: { password: "booking-pw" } });
    const pinned = operationDigest((await connect.admin.operations(s))["booking-db.freeSlots"]!);
    expect((await connect.perform(await sign({ scope: s, action: "booking-db.freeSlots", effect: "read", input: {}, contract: pinned as never }))).status).toBe("ok");
    await connect.admin.installSql(s, bookingConnector("1.0.1", "starts_at desc"));
    const repinned = operationDigest((await connect.admin.operations(s))["booking-db.freeSlots"]!);
    expect(repinned).not.toBe(pinned);
    const ids = async (contract: string) => {
      const outcome = await connect.perform(await sign({ scope: s, action: "booking-db.freeSlots", effect: "read", input: {}, contract: contract as never }));
      return outcome.status === "ok" ? (outcome.output as { rows: Array<{ id: string }> }).rows.map((r) => r.id) : outcome;
    };
    expect(Array.isArray(await ids(pinned))).toBe(true);
    expect(Array.isArray(await ids(repinned))).toBe(true);
    for (const v of ["1.0.2", "1.0.3", "1.0.4", "1.0.5"]) await connect.admin.installSql(s, bookingConnector(v, `starts_at desc, id /* ${v} */`));
    expect(await ids(pinned)).toMatchObject({ status: "final", error: { code: "connect/contract-mismatch" } });
  });

  it("answers a write stopped before COMMIT as not applied, and rolls it back", async () => {
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 300);
    const outcome = await connect.perform(await sign({ action: "booking-db.slowBooking", effect: "write", input: { slotId: "s3", customerRef: "late", reference: "ref-late-001" }, idempotent: true }), stop.signal);
    expect(outcome.status).toBe("retryable");
    await new Promise((r) => setTimeout(r, 1_800));
    const { rows } = await db.pool("postgres", "booking").query("SELECT count(*)::int AS n FROM booking.bookings WHERE reference = 'ref-late-001'");
    expect(rows[0].n).toBe(0);
  });

  it("runs exactly one command, whatever the database's string settings make of the text", async () => {
    await connect.perform(await sign({ action: "booking-db.stacked", effect: "read", input: {} }));
    const { rows } = await db.pool("postgres", "booking").query("SELECT count(*)::int AS n FROM booking.slots WHERE id = 's9'");
    expect(rows[0].n).toBe(0);
  });

  it("stops reading an answer larger than its budget", async () => {
    expect(await connect.perform(await sign({ action: "booking-db.huge", effect: "read", input: {} }))).toMatchObject({ status: "final", error: { code: "sql/result-too-large" } });
  });

  it("leaves no session state for the next call", async () => {
    expect((await connect.perform(await sign({ action: "booking-db.holdLock", effect: "read", input: {} }))).status).toBe("ok");
    const { rows } = await db.pool("postgres", "booking").query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'");
    expect(rows[0].n).toBe(0);
  });

  it("answers dates and zone-less timestamps as the database wrote them", async () => {
    expect(await connect.perform(await sign({ action: "booking-db.slotDay", effect: "read", input: { id: "s1" } }))).toMatchObject({ status: "ok", output: { day: "2026-11-02", local: "2026-11-02 09:00:00" } });
  });

  it("refuses a database address the operator did not allow, and plain TCP to the internet", async () => {
    const strict = await createConnect({ audience: AUDIENCE, engineKeys: engine.engineKeys, connectors: [], pool: db.app, keys });
    try {
      const s = { ...scope, appId: "strict" };
      await strict.admin.installSql(s, bookingConnector());
      const c = await strict.admin.createConnection({ scope: s, connectorId: "booking-db", owner: { business: true }, config: { host: "127.0.0.1", port: db.port, database: "booking", user: "booking_app", tls: "disable" }, secret: { password: "booking-pw" } });
      const read = () => sign({ scope: s, action: "booking-db.freeSlots", effect: "read", input: {} });
      expect(await strict.perform(await read())).toMatchObject({ status: "final", error: { code: "sql/egress-denied" } });
      // The operator's allowlist is not every tenant's: only the tenants it names reach private addresses.
      const other = await createConnect({ audience: AUDIENCE, engineKeys: engine.engineKeys, connectors: [], pool: db.app, keys, egress: { allowPrivate: ["127.0.0.1/32"] } });
      try {
        expect(await other.perform(await read())).toMatchObject({ status: "final", error: { code: "sql/egress-denied" } });
      } finally {
        await other.close();
      }
      await strict.admin.updateConnection(s.tenantId, c.id, c.version, { config: { host: "8.8.8.8", database: "booking", user: "booking_app", tls: "disable" } });
      expect(await strict.perform(await read())).toMatchObject({ status: "final", error: { code: "sql/tls-required" } });
    } finally {
      await strict.close();
    }
  });

  it("refuses a definition that is not valid, and a SQL connection without its password", async () => {
    await expect(connect.admin.installSql(scope, { ...bookingConnector(), operations: { x: { ...bookingConnector().operations.freeSlots!, statement: "select 1; select 2" } } })).rejects.toThrow(/';'/);
    await expect(
      connect.admin.createConnection({ scope, connectorId: "booking-db", owner: { business: true, role: "other" }, config: { host: "127.0.0.1", database: "booking", user: "u" }, secret: null }),
    ).rejects.toThrow(/password/);
  });
});
