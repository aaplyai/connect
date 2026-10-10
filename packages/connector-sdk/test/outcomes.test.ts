import type { JsonValue } from "@aaply/action-contract";
import { describe, expect, it } from "vitest";
import { ConnectorError, defineConnector, fetchErrorOutcome, httpOutcome, safe, type HttpRequest, type OperationDefinition } from "../src/index.js";
import { failedBeforeSending, parseRetryAfter } from "../src/errors.js";
import { redactFields } from "../src/log.js";
import { mockFetch, testConnector, type MockRoutes } from "../src/testing.js";
import { exampleNotes } from "./fixtures/example-notes.js";
import { notesBackend } from "./fixtures/notes-backend.js";

const enc = new TextEncoder();
const response = (status: number, headers: Record<string, string> = {}, body?: string) => ({ status, headers: new Headers(headers), ...(body !== undefined ? { body: enc.encode(body) } : {}) });

describe("ConnectorError", () => {
  it("builds the three failure outcomes", () => {
    expect(ConnectorError.retryable("svc/busy", "Busy.", { retryAfterMs: 1500 }).toOutcome()).toEqual({ status: "retryable", error: { code: "svc/busy", message: "Busy." }, retryAfterMs: 1500 });
    expect(ConnectorError.final("svc/bad", "Bad.").toOutcome()).toEqual({ status: "final", error: { code: "svc/bad", message: "Bad." } });
    expect(ConnectorError.unknown("svc/lost", "Lost.").toOutcome()).toEqual({ status: "unknown", error: { code: "svc/lost", message: "Lost." } });
  });

  it("is recognised across copies and keeps codes and messages bounded", () => {
    const e = ConnectorError.final("x".repeat(300), "m".repeat(900));
    expect(ConnectorError.is(e)).toBe(true);
    expect(ConnectorError.is(new Error("x"))).toBe(false);
    expect(ConnectorError.is({ kind: "final" })).toBe(false);
    expect(e.code).toHaveLength(100);
    expect(e.message).toHaveLength(500);
    expect(ConnectorError.retryable("a", "b", { retryAfterMs: -5 }).retryAfterMs).toBeUndefined();
    expect(e.withKind("unknown").toOutcome().status).toBe("unknown");
  });

  it("carries a bounded staff-only detail through withKind", () => {
    const e = ConnectorError.final("svc/dup", "That already exists.", { detail: "duplicate key (email)=(x@example.com)" });
    expect(e.toOutcome()).toEqual({ status: "final", error: { code: "svc/dup", message: "That already exists.", detail: "duplicate key (email)=(x@example.com)" } });
    expect(e.withKind("unknown").toOutcome()).toEqual({ status: "unknown", error: { code: "svc/dup", message: "That already exists.", detail: "duplicate key (email)=(x@example.com)" } });
    expect(ConnectorError.final("a", "b", { detail: "d".repeat(5000) }).detail).toHaveLength(2000);
    expect(ConnectorError.final("a", "b", { detail: "" }).toOutcome()).toEqual({ status: "final", error: { code: "a", message: "b" } });
  });
});

describe("httpOutcome", () => {
  it.each([408, 425, 429, 500, 502, 503, 504])("maps %i to retryable", (status) => {
    expect(httpOutcome(response(status))).toEqual({ status: "retryable", error: { code: `http/${status}`, message: expect.any(String) } });
  });

  it.each([400, 401, 403, 404, 409, 410, 422, 301, 304, 501])("maps %i to final", (status) => {
    expect(httpOutcome(response(status))).toEqual({ status: "final", error: { code: `http/${status}`, message: expect.any(String) } });
  });

  it("honours Retry-After as seconds or a date", () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    expect(httpOutcome(response(429, { "retry-after": "120" }), now)).toMatchObject({ status: "retryable", retryAfterMs: 120_000 });
    expect(httpOutcome(response(503, { "retry-after": new Date(now + 30_000).toUTCString() }), now)).toMatchObject({ retryAfterMs: 30_000 });
    expect(httpOutcome(response(503, { "retry-after": "soon" }), now)).not.toHaveProperty("retryAfterMs");
    expect(parseRetryAfter("99999999")).toBe(24 * 60 * 60 * 1000);
    expect(parseRetryAfter("-1")).toBeUndefined();
    expect(parseRetryAfter(new Date(now - 5000).toUTCString(), now)).toBe(0);
  });

  it("maps 2xx to ok with a JSON body as output", () => {
    expect(httpOutcome(response(200, { "content-type": "application/json; charset=utf-8" }, '{"a":[1,2]}'))).toEqual({ status: "ok", output: { a: [1, 2] } });
    expect(httpOutcome(response(201, { "content-type": "application/problem+json" }, '{"b":true}'))).toEqual({ status: "ok", output: { b: true } });
    expect(httpOutcome(response(204))).toEqual({ status: "ok", output: null });
    expect(httpOutcome(response(200, { "content-type": "text/plain" }, "hello"))).toEqual({ status: "ok", output: null });
    expect(httpOutcome(response(200, { "content-type": "application/json" }, "{oops"))).toMatchObject({ status: "final", error: { code: "connect/bad-response" } });
  });
});

describe("network errors", () => {
  const nodeError = (code: string) => new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) });

  it("are retryable when nothing was sent, and unknown for a write that may have been", () => {
    expect(failedBeforeSending(nodeError("ECONNREFUSED"))).toBe(true);
    expect(failedBeforeSending(nodeError("ENOTFOUND"))).toBe(true);
    expect(failedBeforeSending(new TypeError("fetch failed", { cause: { errors: [{ code: "ECONNREFUSED" }, { code: "EHOSTUNREACH" }] } }))).toBe(true);
    expect(failedBeforeSending(nodeError("ECONNRESET"))).toBe(false);
    expect(failedBeforeSending(new Error("mystery"))).toBe(false);
    expect(fetchErrorOutcome(nodeError("ECONNREFUSED"), "write")).toMatchObject({ status: "retryable", error: { code: "connect/network" } });
    expect(fetchErrorOutcome(nodeError("ECONNRESET"), "write")).toMatchObject({ status: "unknown", error: { code: "connect/network" } });
    expect(fetchErrorOutcome(nodeError("ECONNRESET"), "read")).toMatchObject({ status: "retryable" });
    expect(fetchErrorOutcome(new DOMException("aborted", "AbortError"), "write")).toMatchObject({ status: "unknown", error: { code: "connect/timeout" } });
    expect(fetchErrorOutcome(new DOMException("aborted", "AbortError"), "read")).toMatchObject({ status: "retryable", error: { code: "connect/timeout" } });
  });
});

/** A write that runs a scripted list of requests, then optionally throws. */
function scripted(flags: Pick<OperationDefinition, "idempotent" | "irreversible">) {
  return defineConnector({
    id: "scripted",
    version: "1.0.0",
    title: "Scripted",
    auth: { kind: "none" },
    egress: ["GET api.example.com/*", "POST api.example.com/*"],
    operations: {
      write: {
        title: "Write",
        effect: "write",
        ...flags,
        input: { type: "object", required: ["steps"], properties: { steps: { type: "array" }, then: { type: "string" } } },
        output: {},
        async handler(input: { steps: JsonValue[]; then?: string }, ctx) {
          for (const step of input.steps) (await ctx.http(step as unknown as HttpRequest)).ensureOk();
          if (input.then === "final") throw ConnectorError.final("svc/refused", "Refused.");
          if (input.then === "retryable") throw ConnectorError.retryable("svc/busy", "Busy.");
          if (input.then === "crash") throw new Error("bug with secret payload");
          return { done: true };
        },
      },
    },
  });
}

describe("write outcomes", () => {
  const routes: MockRoutes = {
    "POST https://api.example.com/created": { status: 201, json: {} },
    "POST https://api.example.com/unavailable": { status: 503, headers: { "retry-after": "7" } },
    "POST https://api.example.com/broken": { status: 500 },
    "POST https://api.example.com/gateway": { status: 504 },
    "POST https://api.example.com/conflict": { status: 409 },
    "POST https://api.example.com/refused": { networkError: "ECONNREFUSED" },
    "POST https://api.example.com/reset": { networkError: "ECONNRESET" },
    "GET https://api.example.com/missing": { status: 404 },
    "GET https://api.example.com/busy": { status: 503 },
    "GET https://api.example.com/ok": { json: {} },
  };
  const post = (path: string) => ({ method: "POST", url: `https://api.example.com/${path}`, json: {} });
  const get = (path: string) => ({ url: `https://api.example.com/${path}` });
  const run = (flags: Pick<OperationDefinition, "idempotent" | "irreversible">, steps: JsonValue[], then?: string) =>
    testConnector(scripted(flags), { routes }).call("write", { steps, ...(then ? { then } : {}) });
  const once = { irreversible: true } as const;
  const dedup = { idempotent: true } as const;

  it.each<[string, JsonValue[], string | undefined, string, string]>([
    ["503 before anything changed", [post("unavailable")], undefined, "retryable", "http/503"],
    ["409: refused, nothing changed", [post("conflict")], undefined, "final", "http/409"],
    ["500: may have changed", [post("broken")], undefined, "unknown", "http/500"],
    ["504: may have changed", [post("gateway")], undefined, "unknown", "http/504"],
    ["connection refused: nothing sent", [post("refused")], undefined, "retryable", "connect/network"],
    ["connection reset: may have been sent", [post("reset")], undefined, "unknown", "connect/network"],
    ["a read before the write fails", [get("busy"), post("created")], undefined, "retryable", "http/503"],
    ["a read after the write fails", [post("created"), get("missing")], undefined, "unknown", "http/404"],
    ["final thrown after the write", [post("created")], "final", "unknown", "svc/refused"],
    ["retryable thrown after the write", [post("created")], "retryable", "unknown", "svc/busy"],
    ["final thrown before any write", [get("ok")], "final", "final", "svc/refused"],
    ["a crash before any write", [get("ok")], "crash", "retryable", "connect/handler-error"],
    ["a crash after the write", [post("created")], "crash", "unknown", "connect/handler-error"],
  ])("non-idempotent write: %s", async (_name, steps, then, status, code) => {
    const outcome = await run(once, steps, then);
    expect(outcome).toMatchObject({ status, error: { code } });
    if ("error" in outcome) expect(outcome.error.message).not.toContain("secret");
  });

  it("keeps Retry-After on a retryable write", async () => {
    expect(await run(once, [post("unavailable")])).toEqual({ status: "retryable", error: expect.objectContaining({ code: "http/503" }), retryAfterMs: 7000 });
  });

  it("an idempotent write may stay retryable after sending, because a retry is de-duplicated", async () => {
    expect(await run(dedup, [post("created")], "retryable")).toMatchObject({ status: "retryable", error: { code: "svc/busy" } });
    expect(await run(dedup, [post("created")], "final")).toMatchObject({ status: "unknown" });
  });

  it("reads are never unknown", async () => {
    const t = testConnector(exampleNotes, { routes: { "GET https://api.example.com/v1/notes/*": { networkError: "ECONNRESET" } } });
    expect(await t.call("get", { id: "n-1" })).toMatchObject({ status: "retryable", error: { code: "connect/network" } });
  });
});

describe("input and output checks", () => {
  it("refuses invalid input before the handler runs", async () => {
    const backend = notesBackend();
    const t = testConnector(exampleNotes, { fetch: backend.fetch });
    for (const input of [{}, { title: "" }, { title: "x", extra: 1 }, { title: 42 }, "text", null, [1]] as unknown[]) {
      const outcome = await t.call("create", input);
      expect(outcome).toMatchObject({ status: "final", error: { code: "connect/invalid-input" } });
    }
    expect(t.handlerCalls).toHaveLength(0);
    expect(backend.fetch.calls).toHaveLength(0);
    expect(await t.call("create", { title: "ok" })).toMatchObject({ status: "ok" });
  });

  it("does not echo input values in the refusal", async () => {
    const t = testConnector(exampleNotes);
    const outcome = await t.call("get", { id: "../../secret-path" });
    expect(outcome).toMatchObject({ status: "final", error: { code: "connect/invalid-input", message: "Invalid input at id: value has the wrong shape." } });
  });

  const shaped = (effect: "read" | "write", returns: () => unknown) =>
    defineConnector({
      id: "shaped",
      version: "1.0.0",
      title: "Shaped",
      auth: { kind: "none" },
      egress: ["POST api.example.com/x"],
      operations: {
        op: {
          title: "Op",
          effect,
          ...(effect === "write" ? { irreversible: true } : {}),
          input: { type: "object" },
          output: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
          handler: async () => returns() as JsonValue,
        },
      },
    });

  it("checks the output: final for a read, unknown for a write", async () => {
    expect(await testConnector(shaped("read", () => ({ id: 7 }))).call("op", {})).toMatchObject({ status: "final", error: { code: "connect/bad-output", message: expect.stringContaining("at id") } });
    expect(await testConnector(shaped("write", () => ({}))).call("op", {})).toMatchObject({ status: "unknown", error: { code: "connect/bad-output" } });
    expect(await testConnector(shaped("read", () => ({ id: "1", when: new Date() }))).call("op", {})).toMatchObject({ status: "final", error: { code: "connect/bad-output" } });
    expect(await testConnector(shaped("read", () => ({ id: "1", fn: () => 1 }))).call("op", {})).toMatchObject({ status: "final", error: { code: "connect/bad-output" } });
    expect(await testConnector(shaped("read", () => ({ id: "1" }))).call("op", {})).toEqual({ status: "ok", output: { id: "1" } });
  });

  it("gives the handler a copy of the input", async () => {
    const mutating = defineConnector({
      ...exampleNotes,
      operations: { ...exampleNotes.operations, get: { ...exampleNotes.operations.get!, handler: async (input) => ((input.id = "changed"), { mutated: true }) } },
    });
    const input = { id: "n-1" };
    await testConnector(mutating).call("get", input);
    expect(input.id).toBe("n-1");
  });
});

describe("time", () => {
  const stuck = defineConnector({
    id: "stuck",
    version: "1.0.0",
    title: "Stuck",
    auth: { kind: "none" },
    egress: ["GET api.example.com/x"],
    operations: {
      wait: { title: "Wait", effect: "read", input: { type: "object" }, output: {}, handler: () => new Promise<JsonValue>(() => undefined) },
      late: {
        title: "Late",
        effect: "read",
        input: { type: "object" },
        output: {},
        async handler(_input, ctx) {
          await new Promise((resolve) => setTimeout(resolve, 40));
          return (await ctx.http({ url: "https://api.example.com/x" })).json();
        },
      },
    },
  });

  it("bounds a handler by its deadline and by cancellation", async () => {
    const t = testConnector(stuck);
    expect(await t.call("wait", {}, { timeoutMs: 20 })).toMatchObject({ status: "retryable", error: { code: "connect/timeout" } });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    expect(await t.call("wait", {}, { signal: controller.signal })).toMatchObject({ status: "retryable", error: { code: "connect/cancelled" } });
    expect(await t.call("wait", {}, { timeoutMs: 0 })).toMatchObject({ status: "retryable", error: { code: "connect/timeout" } });
  });

  it("closes ctx.http once the call is over", async () => {
    const fetch = mockFetch({ "GET https://api.example.com/x": { json: {} } });
    const t = testConnector(stuck, { fetch });
    expect(await t.call("late", {}, { timeoutMs: 10 })).toMatchObject({ status: "retryable", error: { code: "connect/timeout" } });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(fetch.calls).toHaveLength(0);
  });
});

describe("logging", () => {
  it("redacts every value not marked safe", () => {
    expect(redactFields({ email: "a@example.com", count: safe(3), ok: safe(true), nested: { a: 1 }, long: safe("x".repeat(500)) })).toEqual({
      email: "[redacted]",
      count: 3,
      ok: true,
      nested: "[redacted]",
      long: "x".repeat(200),
    });
    expect(redactFields({ "john@example.com": safe(1), fine: safe(null) })).toEqual({ fine: null, _dropped: 1 });
  });

  it("records handler and http events without payload values, paths or credentials", async () => {
    const backend = notesBackend();
    backend.seed("Private title", "Private body");
    const t = testConnector(exampleNotes, { fetch: backend.fetch });
    await t.run("list", { limit: 5 });
    await t.run("create", { title: "Secret plans", body: "Do not log" });
    const text = JSON.stringify(t.logs);
    expect(text).not.toMatch(/Private|Secret|Do not log|test-token|\/v1\/notes/);
    expect(t.logs.map((l) => l.event)).toEqual(["http.response", "notes.listed", "http.response", "notes.created"]);
    expect(t.logs[0]).toMatchObject({ level: "debug", connectorId: "example-notes", operation: "list", connectionId: "conn-test", fields: { method: "GET", host: "api.example.com", status: 200 } });
    expect(t.logs[1]!.fields).toEqual({ count: 1 });
    expect(t.logs[3]!.fields).toEqual({ id: "[redacted]", replayed: false });
  });

  it("refuses interpolated event names", async () => {
    const chatty = defineConnector({
      ...exampleNotes,
      operations: {
        ...exampleNotes.operations,
        get: {
          ...exampleNotes.operations.get!,
          async handler(input, ctx) {
            ctx.log.warn(`looked up ${String(input.id)} for someone@example.com`);
            return { done: true };
          },
        },
      },
    });
    const t = testConnector(chatty);
    await t.call("get", { id: "n-1" });
    expect(t.logs).toEqual([expect.objectContaining({ level: "warn", event: "invalid-event", fields: {} })]);
  });
});
