/**
 * The acceptance test of declared SQL connectors: the real engine runtime
 * runs a booking flow, signs each approved action with its private key and
 * sends it over HTTP to Connect, which performs it on a PostgreSQL database
 * it reaches through a stored connection. What the database holds at the
 * end is what "happened".
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Scope } from "@aaply/action-contract";
import { CONFORMANCE_SCOPE } from "@aaply/action-contract/conformance";
import { createFlowRuntime, createMemoryCatalog, createMemoryStore, e, hmacKeyMinter, pinActionContracts, type ApprovedAction, type FlowDefinition, type FlowRuntime, type JsonSchema, type TrustedContext } from "@aaply/flow";
import { createConnect, type Connect } from "@aaply/connect";
import { serveConnect } from "@aaply/connect/http";
import { postgresUnavailable, startTestDatabase, testEngineKeys, testKeyProvider, type TestDatabase } from "@aaply/connect/testing";
import { BOOKING_SCHEMA, bookingConnector } from "./booking.js";
import { httpPort } from "./support.js";

const AUDIENCE = "connect.engine-test";
const TOKEN = "an-engine-transport-token-long-enough-0123456789";
const scope: Scope = CONFORMANCE_SCOPE;
const none = { sensitivity: "none" } as const;
const str: JsonSchema = { type: "string", minLength: 1 };

/** Book a slot, confirm it, then keep it or cancel it (which undoes the booking in the database). */
const bookSlot: FlowDefinition = {
  schemaVersion: 3,
  id: "book-slot",
  version: "1",
  title: "Book a slot",
  facts: {
    slotId: { type: str, ...none },
    customerRef: { type: str, ...none },
    reference: { type: { type: "string", minLength: 8 }, ...none },
    bookingId: { type: { type: "integer" }, derive: e.result("book", "id"), ...none },
    kept: { type: { type: "boolean" }, ...none },
  },
  actions: {
    book: {
      action: "booking-db.createBooking",
      connection: "bookings",
      effect: "write",
      idempotent: true,
      risk: "confirm",
      input: { slotId: e.fact("slotId"), customerRef: e.fact("customerRef"), reference: e.fact("reference") },
      compensate: { action: "booking-db.cancelBooking", connection: "bookings", input: { reference: e.resource("input", "reference") } },
    },
  },
  steps: [
    { id: "pick", view: { section: "slot_form@1" }, on: { submit: { set: { slotId: e.payload("slotId"), customerRef: e.payload("customerRef"), reference: e.payload("reference") } } } },
    { id: "review", run: "book", view: { section: "review@1" }, on: { confirm: { confirm: true }, cancel: { cancel: true } } },
    { id: "after", view: { section: "booked@1" }, on: { keep: { set: { kept: true } }, cancel: { cancel: true } } },
  ],
  completeWhen: e.known("kept"),
};

describe.skipIf(postgresUnavailable())("the engine runs a booking flow through Connect on PostgreSQL", () => {
  let db: TestDatabase;
  let connect: Connect;
  let close: () => Promise<void>;
  let runtime: FlowRuntime;
  let requests = 0;
  const sent: ApprovedAction[] = [];

  const ctx = (person: string): TrustedContext => ({
    scope,
    environmentKind: "production",
    actor: { domain: "visitor", kind: "visitor", id: person },
    appRoles: [],
    locale: "en-GB",
    timezone: "Asia/Kolkata",
    requestId: `req-${++requests}`,
  });
  const bookings = async () =>
    (await db.pool("postgres", "booking").query("SELECT slot_id, customer_ref, reference, status FROM booking.bookings ORDER BY id")).rows as Array<{ slot_id: string; customer_ref: string; reference: string; status: string }>;

  /** Starts a run, fills in the slot and confirms: the engine sends the signed booking to Connect. */
  async function bookAndConfirm(person: string, slotId: string, reference: string) {
    const { runId } = await runtime.start(ctx(person), { flowId: "book-slot" });
    const review = await runtime.submit(ctx(person), runId, { kind: "output", stepId: "pick", name: "submit", payload: { slotId, customerRef: person, reference } });
    expect(review.view.step?.id).toBe("review");
    const digest = review.view.step!.confirm!.digest;
    const confirmed = await runtime.submit(ctx(person), runId, { kind: "output", stepId: "review", name: "confirm", digest });
    return { runId, view: confirmed.view };
  }

  async function drain() {
    for (let i = 0; i < 20; i++) {
      const done = await runtime.work();
      if (done.actions === 0 && done.timers === 0) return;
    }
  }

  beforeAll(async () => {
    db = await startTestDatabase({ tcp: true });
    await db.pool("postgres", "postgres").query("CREATE DATABASE booking");
    await db.pool("postgres", "booking").query(BOOKING_SCHEMA);

    // Across trust domains: the engine holds the private key; Connect holds only the public one.
    const engine = await testEngineKeys();
    connect = await createConnect({ audience: AUDIENCE, engineKeys: engine.engineKeys, connectors: [], pool: db.app, keys: testKeyProvider(), egress: { allowPrivate: ["127.0.0.1/32"], sqlPrivateTenants: [scope.tenantId] } });
    await connect.admin.installSql(scope, bookingConnector());
    await connect.admin.createConnection({
      scope,
      connectorId: "booking-db",
      owner: { business: true, role: "bookings" },
      config: { host: "127.0.0.1", port: db.port, database: "booking", user: "booking_app", tls: "disable" },
      secret: { password: "booking-pw" },
    });
    const served = await serveConnect(connect, { port: 0, performToken: TOKEN });
    close = () => served.close();
    const { port } = served.server.address() as { port: number };

    // Published as a host would: each action pinned to the operation contract Connect lists, which covers its SQL.
    const operations = await connect.admin.operations(scope);
    const pinned = pinActionContracts(bookSlot, operations);
    expect(pinned.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const catalog = createMemoryCatalog();
    catalog.publish(scope, pinned.definition);
    const http = httpPort(`http://127.0.0.1:${port}`, TOKEN);
    runtime = createFlowRuntime({
      catalog,
      store: createMemoryStore(),
      actions: { run: (a, signal) => (sent.push(a), http.run(a, signal)) },
      keys: hmacKeyMinter("engine-test-idempotency-secret-0123456789"),
      envelopes: { audience: AUDIENCE, signer: engine.signer },
      operations,
      policy: () => ({ mode: "off" }),
    });
  });
  afterAll(async () => {
    await close?.();
    await connect?.close();
    await db?.close();
  });

  it("books a slot the person confirmed, and keeps it", async () => {
    const { runId, view } = await bookAndConfirm("ana", "s1", "ref-ana-0001");
    expect(view.step?.id).toBe("after");
    const kept = await runtime.submit(ctx("ana"), runId, { kind: "output", stepId: "after", name: "keep" });
    expect(kept.view.run).toBe("completed");
    expect(await bookings()).toEqual([{ slot_id: "s1", customer_ref: "ana", reference: "ref-ana-0001", status: "booked" }]);
  });

  it("shows the database's own conflict when the slot is taken, and books nothing", async () => {
    const { view } = await bookAndConfirm("bo", "s1", "ref-bo-00001");
    expect(view.status).toBe("failed");
    expect(view.step?.error).toMatchObject({ code: "booking/slot-taken" });
    expect((await bookings()).filter((b) => b.customer_ref === "bo")).toEqual([]);
  });

  it("cancels: the engine sends the declared undo, and the slot is free again", async () => {
    const { runId, view } = await bookAndConfirm("cy", "s2", "ref-cy-00001");
    expect(view.step?.id).toBe("after");
    await runtime.submit(ctx("cy"), runId, { kind: "output", stepId: "after", name: "cancel" });
    await drain();
    expect((await runtime.view(ctx("cy"), runId)).run).toBe("cancelled");
    expect((await bookings()).find((b) => b.reference === "ref-cy-00001")?.status).toBe("cancelled");
    const again = await bookAndConfirm("dee", "s2", "ref-dee-0001");
    expect(again.view.step?.id).toBe("after");
  });

  it("pins every envelope it sends, the undo included", () => {
    expect(sent.length).toBeGreaterThan(3);
    for (const a of sent) expect(a.action.contract, a.action.id).toMatch(/^sha256:/);
    expect(sent.some((a) => a.action.id === "booking-db.cancelBooking")).toBe(true);
  });

  it("still undoes a booking after the database connector was changed under the run", async () => {
    const { runId } = await bookAndConfirm("eve", "s3", "ref-eve-0001");
    await connect.admin.installSql(scope, bookingConnector("1.1.0", "starts_at", "v1.1"));
    await runtime.submit(ctx("eve"), runId, { kind: "output", stepId: "after", name: "cancel" });
    await drain();
    expect((await runtime.view(ctx("eve"), runId)).run).toBe("cancelled");
    expect((await bookings()).find((b) => b.reference === "ref-eve-0001")?.status).toBe("cancelled");
  });
});
