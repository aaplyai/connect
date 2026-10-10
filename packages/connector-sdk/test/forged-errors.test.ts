/**
 * A thrown value is someone's word (ADR-0009, amended by the verification of
 * the 0.2 gaps): the kit recognises a `ConnectorError` by a brand any value
 * can carry, so it reads the fields of one once, into a `ConnectorError` of
 * its own (`adoptConnectorError`), and never calls its methods. A handler or
 * a host hook can then neither answer one code to the check-only rule and
 * another in its outcome, nor answer an outcome the kit did not build; and
 * the port refuses to pass on an outcome without an outcome's shape.
 */

import type { ActionOutcome, ApprovedAction, JsonObject } from "@aaply/action-contract";
import { CONFORMANCE_AUDIENCE, conformanceVerifier, draftApprovedAction } from "@aaply/action-contract/conformance";
import { describe, expect, it, vi } from "vitest";
import { adoptConnectorError } from "../src/errors.js";
import { ConnectorError, createConnectorActionPort, defineConnector, handleWebhook, memoryBlobStore, memoryReplayGuard, type ConnectorActionPortOptions } from "../src/index.js";
import * as invoke from "../src/invoke.js";
import { TEST_SCOPE, mockFetch } from "../src/testing.js";

vi.mock("../src/invoke.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/invoke.js")>();
  return { ...real, invokeOperation: vi.fn(real.invokeOperation) };
});

const API = "https://api.mail.test/v1";
const NOW = Date.UTC(2026, 9, 9);
const clock = { now: () => NOW };
const BRAND = Symbol.for("@aaply/connector-sdk/ConnectorError");

/** An object with the brand and `fields`, whose methods record that they were called and answer `answer`. */
function forged(calls: string[], fields: Record<string, unknown>, answer: unknown = { status: "ok", output: { forged: true } }) {
  return {
    [BRAND]: true,
    ...fields,
    toOutcome: () => (calls.push("toOutcome"), answer),
    withKind() {
      calls.push("withKind");
      return this;
    },
  };
}

/** A real ConnectorError whose own fields are getters that count their reads and change after the first. */
function shifting(reads: Record<string, number>, kind: string, code: string): ConnectorError {
  const error = ConnectorError.final("mail/x", "m");
  const twice = (name: string, first: unknown, then: unknown) =>
    Object.defineProperty(error, name, { get: () => ((reads[name] = (reads[name] ?? 0) + 1) === 1 ? first : then) });
  twice("kind", kind, "retryable");
  twice("code", code, "connect/contract-unsupported");
  twice("message", "m", "other");
  return error;
}

function mailPort(error: () => unknown, post: boolean, over: Partial<ConnectorActionPortOptions> = {}) {
  const fetch = mockFetch({ [`POST ${API}/*`]: { json: { id: "m-1" } }, [`GET ${API}/*`]: { json: { id: "m-1" } } });
  const errors: string[] = [];
  const handler = async (_input: JsonObject, ctx: { http: (r: object) => Promise<unknown> }) => {
    if (post) await ctx.http({ method: "POST", url: `${API}/send`, json: {} });
    throw error();
  };
  const mail = defineConnector({
    id: "mail",
    version: "1.0.0",
    title: "Mail",
    auth: { kind: "none" },
    egress: [`POST api.mail.test/v1/*`, `GET api.mail.test/v1/*`],
    operations: {
      send: { title: "Send", effect: "write", irreversible: true, input: { type: "object" }, output: { type: "object" }, handler: handler as never },
      get: { title: "Get", effect: "read", input: { type: "object" }, output: { type: "object", required: ["id"], properties: { id: { type: "string" } } }, handler: handler as never },
    },
  });
  const port = createConnectorActionPort({
    audience: CONFORMANCE_AUDIENCE,
    verifier: conformanceVerifier(),
    replayGuard: memoryReplayGuard(clock),
    connectors: [mail],
    connections: () => ({ connectionId: "c", grantedScopes: [], subjectId: null }),
    credentials: { headers: () => ({}) },
    fetch,
    clock,
    observer: { error: (_error, where) => errors.push(where) },
    ...over,
  });
  return { port, fetch, errors };
}

const envelope = (op: "send" | "get", action = `mail.${op}`): ApprovedAction =>
  draftApprovedAction({ action, effect: op === "get" ? "read" : "write", input: {}, now: NOW, role: null, subject: null, idempotent: false });

describe("adoptConnectorError", () => {
  it("copies a branded value's fields once, into a ConnectorError of the kit's own, and calls none of its methods", () => {
    const calls: string[] = [];
    const adopted = adoptConnectorError(forged(calls, { kind: "retryable", code: "mail/busy", message: "Busy.", retryAfterMs: 1500, limit: "connection", detail: "d" }));
    expect(calls).toEqual([]);
    expect(adopted).toBeInstanceOf(ConnectorError);
    expect(Object.getPrototypeOf(adopted)).toBe(ConnectorError.prototype);
    expect(adopted!.toOutcome()).toEqual({ status: "retryable", error: { code: "mail/busy", message: "Busy.", detail: "d" }, retryAfterMs: 1500, limit: "connection" });
    const reads: Record<string, number> = {};
    const copy = adoptConnectorError(shifting(reads, "final", "mail/no"));
    expect(reads).toEqual({ kind: 1, code: 1, message: 1 });
    expect(copy!.toOutcome()).toEqual({ status: "final", error: { code: "mail/no", message: "m" } });
  });

  it("refuses what is not a ConnectorError's fields, and what does not carry the brand, without throwing", () => {
    const calls: string[] = [];
    const fine = { kind: "final", code: "mail/no", message: "m" };
    expect(adoptConnectorError(forged(calls, fine))).not.toBeNull();
    for (const bad of [{ kind: "ok" }, { kind: undefined }, { code: 5 }, { code: undefined }, { message: { text: "m" } }, { retryAfterMs: "1000" }, { retryAfterMs: -1 }, { retryAfterMs: Infinity }, { limit: "everyone" }, { detail: 7 }]) {
      expect(adoptConnectorError(forged(calls, { ...fine, ...bad })), JSON.stringify(bad)).toBeNull();
    }
    expect(adoptConnectorError({ ...fine })).toBeNull();
    expect(adoptConnectorError(new Error("plain"))).toBeNull();
    const throwing = new Proxy({}, { get: () => { throw new Error("no"); } });
    expect(ConnectorError.is(throwing)).toBe(false);
    expect(adoptConnectorError(throwing)).toBeNull();
    const branded = new Proxy({ [BRAND]: true }, { get: (_target, key) => { if (key === BRAND) return true; throw new Error("no"); } });
    expect(adoptConnectorError(branded)).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe("a handler's thrown ConnectorError", () => {
  it("is answered from its fields, never its own outcome, whatever its methods say", async () => {
    const calls: string[] = [];
    const t = mailPort(() => forged(calls, { kind: "final", code: "mail/refused", message: "No." }), false);
    expect(await t.port.run(envelope("send"))).toEqual({ status: "final", error: { code: "mail/refused", message: "No." } });
    // A read whose own outcome is an `ok` the output schema would refuse: it never gets past the check.
    expect(await t.port.run(envelope("get"))).toEqual({ status: "final", error: { code: "mail/refused", message: "No." } });
    expect(calls).toEqual([]);
  });

  it("goes unknown after a POST from its copy too, and never claims a check that did not run", async () => {
    const calls: string[] = [];
    const t = mailPort(() => forged(calls, { kind: "retryable", code: "mail/fine", message: "m" }, { status: "retryable", error: { code: "connect/contract-unsupported", message: "m" } }), true);
    expect(await t.port.run(envelope("send"))).toEqual({ status: "unknown", error: { code: "mail/fine", message: "m" } });
    const reads: Record<string, number> = {};
    const s = mailPort(() => shifting(reads, "retryable", "mail/fine"), false);
    expect(await s.port.run(envelope("get"))).toEqual({ status: "retryable", error: { code: "mail/fine", message: "m" } });
    expect(reads.code).toBe(1);
    expect(calls).toEqual([]);
  });

  it("whose fields are not a ConnectorError's is the handler's fault, reported", async () => {
    const calls: string[] = [];
    const t = mailPort(() => forged(calls, { kind: "applied", code: "mail/fine", message: "m" }), false);
    expect(await t.port.run(envelope("send"))).toEqual({
      status: "retryable",
      error: { code: "connect/handler-error", message: "The connector had a problem.", detail: "the call threw a value with the kit's error brand whose fields are not a ConnectorError's" },
    });
    expect(t.errors).toEqual(["connector:mail.send"]);
    expect(calls).toEqual([]);
  });
});

describe("a host hook's thrown ConnectorError", () => {
  it("from the connection resolver, the credential provider, the signer or the file store is read for its fields only", async () => {
    const calls: string[] = [];
    const refusal = () => forged(calls, { kind: "final", code: "connect/reconsent", message: "Reconnect." });
    const want = { status: "final", error: { code: "connect/reconsent", message: "Reconnect." } };
    const resolver = mailPort(() => new Error("never runs"), false, {
      connections: () => {
        throw refusal();
      },
    });
    expect(await resolver.port.run(envelope("send"))).toEqual(want);

    /** What the handler met: a ConnectorError of the kit's, never the hook's object (compared by identity: toEqual finds any two prototypes equal). */
    const met: unknown[] = [];
    const authed = (credentials: ConnectorActionPortOptions["credentials"]) => {
      const vault = defineConnector({
        id: "vault",
        version: "1.0.0",
        title: "Vault",
        auth: { kind: "apiKey" },
        egress: [`POST api.mail.test/v1/*`],
        operations: {
          send: {
            title: "Send",
            effect: "write",
            irreversible: true,
            input: { type: "object" },
            output: { type: "object" },
            // Two requests: a refusal at the second comes after the first may have applied the write.
            handler: async (_i, ctx) => {
              try {
                await ctx.http({ method: "POST", url: `${API}/send` });
                return (await ctx.http({ method: "POST", url: `${API}/send` })).ensureOk().json();
              } catch (error) {
                met.push(error);
                throw error;
              }
            },
          },
        },
      });
      const fetch = mockFetch({ [`POST ${API}/*`]: { json: { id: "m-1" } } });
      const port = createConnectorActionPort({ audience: CONFORMANCE_AUDIENCE, verifier: conformanceVerifier(), replayGuard: memoryReplayGuard(clock), connectors: [vault], connections: () => ({ connectionId: "c", grantedScopes: [], subjectId: null }), credentials, fetch, clock });
      return { run: () => port.run(draftApprovedAction({ action: "vault.send", effect: "write", input: {}, now: NOW, role: null, subject: null })), fetch };
    };
    const provider = authed({
      headers: () => {
        throw refusal();
      },
    });
    expect(await provider.run()).toEqual(want);
    expect(provider.fetch.calls).toHaveLength(0);
    expect(met.map((e) => Object.getPrototypeOf(e) === ConnectorError.prototype)).toEqual([true]);
    let signed = 0;
    const signer = authed({
      headers: () => ({ authorization: "Bearer t" }),
      sign: () => {
        if (signed++ === 0) return {};
        throw refusal();
      },
    });
    // After the first request the write may have been applied: the copy goes unknown, and the object's own withKind is never asked.
    expect(await signer.run()).toEqual({ status: "unknown", error: want.error });
    expect(signer.fetch.calls).toHaveLength(1);
    expect(met.map((e) => Object.getPrototypeOf(e) === ConnectorError.prototype)).toEqual([true, true]);

    const store = memoryBlobStore();
    let seen: unknown;
    const files = defineConnector({
      id: "files",
      version: "1.0.0",
      title: "Files",
      auth: { kind: "none" },
      egress: [],
      operations: {
        store: {
          title: "Store",
          effect: "read",
          input: { type: "object" },
          output: {},
          handler: async (_i, ctx) => {
            try {
              return (await ctx.blobs.put(new TextEncoder().encode("x"), { mediaType: "text/plain" })) as never;
            } catch (error) {
              seen = error;
              throw error;
            }
          },
        },
      },
    });
    const failing = { ...store, put: async () => Promise.reject(refusal()) };
    const outcome = await invoke.invokeOperation(files, "store", {}, { fetch: mockFetch(), deadline: Date.now() + 5000, idempotencyKey: "k", connection: { id: "c", role: null }, credentials: async () => ({}), scope: TEST_SCOPE, blobs: failing });
    expect(outcome).toEqual(want);
    // The handler met a ConnectorError of the kit's, not the store's object.
    expect(Object.getPrototypeOf(seen)).toBe(ConnectorError.prototype);
    expect(calls).toEqual([]);
  });

  it("from a webhook's hooks is read for its fields only", async () => {
    let reads = 0;
    const refusal = { [BRAND]: true, kind: "final", code: "pay/bad", get message() { reads++; return "Bad body."; } };
    const hooks = (parse: () => unknown, verify: () => unknown = () => true) =>
      defineConnector({
        id: "pay",
        version: "1.0.0",
        title: "Pay",
        auth: { kind: "none" },
        egress: [],
        operations: { get: { title: "Get", effect: "read", input: { type: "object" }, output: {}, handler: () => null } },
        webhooks: { verify: verify as never, parse: parse as never },
      });
    const request = { method: "post", url: "https://hooks.host.test/c/1", headers: {}, body: new Uint8Array(0) };
    const thrown = () => {
      throw refusal;
    };
    expect(await handleWebhook(hooks(thrown), request, { connectionId: "c", subjectId: null })).toEqual({ ok: false, code: "connect/webhook-invalid", status: 400, message: "Bad body." });
    expect(reads).toBe(1);
    expect(await handleWebhook(hooks(() => [], thrown), request, { connectionId: "c", subjectId: null })).toMatchObject({ ok: false, code: "connect/webhook-unverified", status: 401 });
    expect(await handleWebhook(hooks(() => { throw { ...refusal, kind: "maybe" }; }), request, { connectionId: "c", subjectId: null })).toMatchObject({ ok: false, code: "connect/webhook-unavailable", status: 503 });
  });
});

describe("the port's answer", () => {
  it("is an outcome the kit builds, or connect/internal: never something else the call answered", async () => {
    const odd: unknown[] = [{ status: "ok" }, { status: "done", output: {} }, { status: "final", error: { code: 5, message: "m" } }, { status: "retryable" }, { status: "pending", ref: 7 }, { status: "ok", output: () => 1 }, null];
    for (const raw of odd) {
      for (const op of ["send", "get"] as const) {
        const t = mailPort(() => new Error("never runs"), false);
        vi.mocked(invoke.invokeOperation).mockResolvedValueOnce(raw as ActionOutcome);
        const outcome = await t.port.run(envelope(op));
        expect(outcome, `${op} ${JSON.stringify(raw)}`).toEqual({ status: op === "send" ? "unknown" : "retryable", error: { code: "connect/internal", message: "The connector kit had a problem." } });
        expect(t.errors).toEqual(["connector-port:outcome"]);
      }
    }
    // A well-formed one goes through as it is.
    const t = mailPort(() => ConnectorError.final("mail/no", "No."), false);
    expect(await t.port.run(envelope("send"))).toEqual({ status: "final", error: { code: "mail/no", message: "No." } });
  });
});
