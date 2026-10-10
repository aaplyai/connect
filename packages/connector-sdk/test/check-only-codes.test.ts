/**
 * A code that says "refused before anything ran" comes only from the kit's own
 * checks (ADR-0009, amended by the verification of the 0.2 gaps). The engine
 * sends the same attempt again after `connect/contract-unsupported`, so a
 * handler, or a host hook it calls, that throws one is answered as a fault of
 * the call (`connect/handler-error`): `retryable`, or `unknown` once a write
 * may have been sent. Codes a call may meet (an account to reconnect, a rate
 * limit) pass through as before.
 */

import { CONNECT_REFUSALS, type ApprovedAction, type JsonObject } from "@aaply/action-contract";
import { CONFORMANCE_AUDIENCE, actionPortConformance, conformanceVerifier, draftApprovedAction } from "@aaply/action-contract/conformance";
import { describe, expect, it } from "vitest";
import {
  CHECK_ONLY_CODES,
  ConnectorError,
  REFUSAL_ORIGINS,
  createConnectorActionPort,
  defineConnector,
  isCheckOnlyCode,
  memoryReplayGuard,
  type ConnectorActionPortOptions,
  type FailureKind,
} from "../src/index.js";
import { mockFetch } from "../src/testing.js";

const API = "https://api.mail.test/v1";
const NOW = Date.UTC(2026, 9, 8);
const clock = { now: () => NOW };
/** Codes only the engine records, which no call may answer either. */
const ENGINE_CODES = ["flow/withdrawn", "flow/contract-unsupported", "flow/interrupted", "flow/sign-failed"];

/** What each operation's handler does: POST first or not, then throw. */
interface Plan {
  post: boolean;
  error: unknown;
}

function mailPort(plan: Plan, over: Partial<ConnectorActionPortOptions> = {}) {
  const fetch = mockFetch({ [`POST ${API}/*`]: { json: { id: "m-1" } }, [`GET ${API}/*`]: { json: { id: "m-1" } } });
  const errors: Array<{ error: unknown; where: string }> = [];
  const handler = async (_input: JsonObject, ctx: { http: (r: object) => Promise<unknown> }) => {
    if (plan.post) await ctx.http({ method: "POST", url: `${API}/send`, json: {} });
    throw plan.error;
  };
  const mail = defineConnector({
    id: "mail",
    version: "1.0.0",
    title: "Mail",
    auth: { kind: "none" },
    egress: [`POST api.mail.test/v1/*`, `GET api.mail.test/v1/*`],
    operations: {
      send: { title: "Send", effect: "write", irreversible: true, input: { type: "object" }, output: { type: "object" }, handler: handler as never },
      put: { title: "Put", effect: "write", idempotent: true, input: { type: "object" }, output: { type: "object" }, handler: handler as never },
      get: { title: "Get", effect: "read", input: { type: "object" }, output: { type: "object" }, handler: handler as never },
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
    observer: { error: (error, where) => errors.push({ error, where }) },
    ...over,
  });
  return { port, fetch, errors };
}

const envelope = (op: "send" | "put" | "get", over: Partial<Parameters<typeof draftApprovedAction>[0]> = {}): ApprovedAction =>
  draftApprovedAction({ action: `mail.${op}`, effect: op === "get" ? "read" : "write", input: {}, now: NOW, role: null, subject: null, idempotent: op !== "send", ...over });

const KINDS: FailureKind[] = ["retryable", "final", "unknown"];

describe("where a refusal code may come from", () => {
  it("places every refusal of the contract, and nothing else", () => {
    const table = Object.keys(CONNECT_REFUSALS);
    const placed = Object.keys(REFUSAL_ORIGINS);
    expect(table.length).toBeGreaterThan(0);
    expect(new Set(placed)).toEqual(new Set(table));
    const checks = placed.filter((code) => REFUSAL_ORIGINS[code as keyof typeof REFUSAL_ORIGINS] === "check");
    expect(checks).toContain("connect/contract-unsupported");
    expect(checks).toContain("connect/replayed");
    expect(new Set(CHECK_ONLY_CODES)).toEqual(new Set([...checks, "connect/resolver-error", "connect/invalid-connector"]));
    for (const code of ENGINE_CODES) expect(isCheckOnlyCode(code)).toBe(true);
    for (const code of ["connect/reconsent", "connect/rate-limited", "connect/egress-denied", "http/503", "mail/quota"]) expect(isCheckOnlyCode(code)).toBe(false);
  });
});

describe("a check-only code thrown during a call", () => {
  const codes = [...CHECK_ONLY_CODES, ...ENGINE_CODES];

  it("is the handler's fault before anything was sent: retryable connect/handler-error, reported", async () => {
    expect(codes.length).toBeGreaterThan(ENGINE_CODES.length);
    for (const code of codes) {
      for (const kind of KINDS) {
        for (const op of ["send", "put", "get"] as const) {
          const t = mailPort({ post: false, error: new ConnectorError(kind, code, "Not this.", { retryAfterMs: 1000 }) });
          const outcome = await t.port.run(envelope(op));
          expect(outcome, `${op} ${kind} ${code}`).toEqual({
            status: "retryable",
            error: { code: "connect/handler-error", message: "The connector had a problem.", detail: `the call threw ${code}, which only the kit's checks before running answer` },
          });
          expect(t.errors.map((e) => e.where)).toEqual(["connector:mail." + op]);
          expect(t.fetch.calls).toHaveLength(0);
        }
      }
    }
  });

  it("is unknown once a write may have been sent, idempotent or not", async () => {
    for (const code of codes) {
      for (const kind of KINDS) {
        for (const op of ["send", "put"] as const) {
          const t = mailPort({ post: true, error: new ConnectorError(kind, code, "Not this.") });
          expect(await t.port.run(envelope(op)), `${op} ${kind} ${code}`).toMatchObject({ status: "unknown", error: { code: "connect/handler-error" } });
          expect(t.fetch.calls).toHaveLength(1);
        }
      }
    }
  });

  it("from the host's credential provider, inside a request, is a fault of the call too", async () => {
    const authed = defineConnector({
      id: "vault",
      version: "1.0.0",
      title: "Vault",
      auth: { kind: "apiKey" },
      egress: [`POST api.mail.test/v1/*`],
      operations: { send: { title: "Send", effect: "write", irreversible: true, input: { type: "object" }, output: { type: "object" }, handler: async (_i, ctx) => (await ctx.http({ method: "POST", url: `${API}/send` })).ensureOk().json() } },
    });
    const fetch = mockFetch({ [`POST ${API}/*`]: { json: { id: "m-1" } } });
    const port = createConnectorActionPort({
      audience: CONFORMANCE_AUDIENCE,
      verifier: conformanceVerifier(),
      replayGuard: memoryReplayGuard(clock),
      connectors: [authed],
      connections: () => ({ connectionId: "c", grantedScopes: [], subjectId: null }),
      credentials: {
        headers: () => {
          throw ConnectorError.retryable("connect/contract-unsupported", "Not this.");
        },
      },
      fetch,
      clock,
    });
    expect(await port.run(draftApprovedAction({ action: "vault.send", effect: "write", input: {}, now: NOW, role: null, subject: null }))).toMatchObject({ status: "retryable", error: { code: "connect/handler-error" } });
    expect(fetch.calls).toHaveLength(0);
  });
});

describe("codes a call may meet", () => {
  it("pass through unchanged, as before", async () => {
    const met = Object.entries(REFUSAL_ORIGINS).filter(([, origin]) => origin === "call").map(([code]) => code);
    expect(met).toContain("connect/reconsent");
    for (const code of [...met, "mail/quota"]) {
      const t = mailPort({ post: false, error: ConnectorError.final(code, "No.") });
      expect(await t.port.run(envelope("send")), code).toEqual({ status: "final", error: { code, message: "No." } });
      expect(t.errors).toHaveLength(0);
    }
  });
});

describe("the host's connection resolver", () => {
  it("may refuse for the account, but a check-only code is a resolver error", async () => {
    const refusing = (error: ConnectorError) =>
      mailPort(
        { post: false, error: new Error("never runs") },
        {
          connections: () => {
            throw error;
          },
        },
      );
    const own = refusing(ConnectorError.retryable("connect/contract-unsupported", "Not this.", { retryAfterMs: 30_000 }));
    expect(await own.port.run(envelope("send"))).toEqual({ status: "retryable", error: { code: "connect/resolver-error", message: "The connection could not be looked up." } });
    expect(own.errors.map((e) => e.where)).toEqual(["connector-port:connections"]);
    const account = refusing(ConnectorError.final("connect/no-connection", "Connect an account first."));
    expect(await account.port.run(envelope("send"))).toEqual({ status: "final", error: { code: "connect/no-connection", message: "Connect an account first." } });
  });
});

describe("an attempt refused for its contract version", () => {
  it("is performed when sent again in a version the port serves, a write that does not de-duplicate included", async () => {
    const fetch = mockFetch({ [`POST ${API}/*`]: { json: { id: "m-1" } }, [`GET ${API}/*`]: { json: { id: "m-1" } } });
    const ok = async (_i: JsonObject, ctx: { http: (r: object) => Promise<{ ensureOk(): { json(): Promise<unknown> } }> }) => (await ctx.http({ method: "POST", url: `${API}/send`, json: {} })).ensureOk().json();
    const mail = defineConnector({
      id: "mail",
      version: "1.0.0",
      title: "Mail",
      auth: { kind: "none" },
      egress: [`POST api.mail.test/v1/*`, `GET api.mail.test/v1/*`],
      operations: {
        send: { title: "Send", effect: "write", irreversible: true, input: { type: "object" }, output: { type: "object" }, handler: ok as never },
        get: { title: "Get", effect: "read", input: { type: "object" }, output: { type: "object" }, handler: async (_i, ctx) => (await ctx.http({ url: `${API}/m-1` })).ensureOk().json() },
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
    });
    const cases = actionPortConformance(port, {
      read: { action: "mail.get", input: {}, role: null },
      performedWrite: { action: "mail.send", input: {}, role: null, idempotent: false },
      performed: () => fetch.calls.length,
      now: clock.now,
    });
    const resend = cases.find((c) => c.name === "performs an attempt it refused for its contract version, sent again in one it serves");
    expect(resend).toBeDefined();
    await resend!.run();
    expect(fetch.calls.map((c) => c.method)).toEqual(["GET", "POST"]);
  });
});
