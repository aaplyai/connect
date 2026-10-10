/**
 * The contract's side of the Connect context (ADR-0002, amended): completion
 * windows, the environment kind, contract-version discovery, the traceparent
 * and authTime.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ACTION_CONTRACT_VERSION, ACTION_CONTRACT_VERSIONS, CONNECT_REFUSALS, CONTRACT_UNSUPPORTED_RETRY_MS, isActionPortDescription, pickContractVersion, ENVIRONMENT_KINDS, MAX_COMPLETION_WINDOW_MS, checkApprovedAction, environmentAllows, isEnvironmentKind, isOperationCompletion, refuse, verifyApprovedAction, type ActionPort, type EnvironmentKind, isOperationContract, operationDigest, type OperationContract, TRACEPARENT_RE, isTraceparent } from "../src/index.js";
import { CONFORMANCE_AUDIENCE, actionPortConformance, conformanceVerifier, draftApprovedAction, sealApprovedAction } from "../src/api/conformance.js";

const DAY = 24 * 60 * 60 * 1000;
const hashOf = (text: string) => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;

const send: OperationContract = { effect: "write", idempotent: false, irreversible: true, riskFloor: "none", input: { type: "object" }, output: { type: "object" } };

describe("an operation's completion window", () => {
  it("is a positive whole number of milliseconds, up to 30 days, and nothing else", () => {
    expect(MAX_COMPLETION_WINDOW_MS).toBe(30 * DAY);
    for (const ok of [{ windowMs: 1 }, { windowMs: DAY }, { windowMs: 30 * DAY }]) expect(isOperationCompletion(ok)).toBe(true);
    for (const bad of [null, [], 5, {}, { windowMs: 0 }, { windowMs: -1 }, { windowMs: 1.5 }, { windowMs: 30 * DAY + 1 }, { windowMs: "1000" }, { windowMs: Number.NaN }, { windowMs: 1000, extra: true }]) {
      expect(isOperationCompletion(bad)).toBe(false);
      expect(isOperationContract({ ...send, completion: bad })).toBe(false);
    }
    const hostile = new Proxy({}, { ownKeys: () => { throw new Error("no"); } });
    expect(isOperationCompletion(hostile)).toBe(false);
    expect(isOperationContract({ ...send, completion: { windowMs: DAY } })).toBe(true);
  });

  it("leaves the digest of a contract without one as it was, and changes it only when present", () => {
    // The digest's input, written out by hand: canonical JSON, keys sorted.
    const without = '{"effect":"write","idempotent":false,"input":{"type":"object"},"irreversible":true,"operationContract":1,"output":{"type":"object"},"riskFloor":"none"}';
    expect(operationDigest(send)).toBe(hashOf(without));
    const withWindow = '{"completion":{"windowMs":86400000},"effect":"write","idempotent":false,"input":{"type":"object"},"irreversible":true,"operationContract":1,"output":{"type":"object"},"riskFloor":"none"}';
    expect(operationDigest({ ...send, completion: { windowMs: DAY } })).toBe(hashOf(withWindow));
    expect(operationDigest({ ...send, completion: { windowMs: DAY + 1 } })).not.toBe(hashOf(withWindow));
  });
});

describe("the environment kind", () => {
  const NOW = Date.UTC(2026, 9, 8);

  it("is production, preview or test, and an envelope of any other kind is malformed", () => {
    expect([...ENVIRONMENT_KINDS].sort()).toEqual(["preview", "production", "test"]);
    for (const kind of ENVIRONMENT_KINDS) {
      expect(isEnvironmentKind(kind)).toBe(true);
      expect(checkApprovedAction(draftApprovedAction({ action: "notes.get", effect: "read", input: {}, now: NOW, environment: kind }), { now: NOW }).ok).toBe(true);
    }
    for (const bad of ["staging", "Production", "", null, undefined, 1]) {
      expect(isEnvironmentKind(bad)).toBe(false);
      const a = sealApprovedAction({ ...draftApprovedAction({ action: "notes.get", effect: "read", input: {}, now: NOW }), environment: bad as EnvironmentKind });
      expect(checkApprovedAction(a, { now: NOW })).toMatchObject({ ok: false, outcome: { status: "final", error: { code: "connect/invalid-envelope" } } });
    }
    // Drafts are production unless told otherwise: the kind of a connection that declares none.
    expect(draftApprovedAction({ action: "notes.get", effect: "read", input: {}, now: NOW }).environment).toBe("production");
  });

  it("allows exactly the connection's own kind, and an undeclared connection is production", () => {
    for (const call of ENVIRONMENT_KINDS) {
      for (const connection of [...ENVIRONMENT_KINDS, undefined]) expect(environmentAllows(call, connection)).toBe(call === (connection ?? "production"));
    }
    expect(CONNECT_REFUSALS["connect/environment-mismatch"]).toBe("final");
    expect(refuse("connect/environment-mismatch", "Other.")).toEqual({ status: "final", error: { code: "connect/environment-mismatch", message: "Other." } });
  });

  /** A port with one connection, of kind `kind`, that checks the kind only when `checks`. */
  function onePort(kind: EnvironmentKind, checks: boolean): { port: ActionPort; performed: () => number } {
    let performed = 0;
    const port: ActionPort = {
      async run(value) {
        const check = await verifyApprovedAction(value, { now: Date.now(), audience: CONFORMANCE_AUDIENCE, verifier: conformanceVerifier() });
        if (!check.ok) return check.outcome;
        if (check.action.action.id !== "notes.get") return refuse("connect/unknown-action", "Unknown.");
        if (check.action.action.contract !== undefined) return refuse("connect/contract-mismatch", "Changed.");
        if (check.action.action.effect !== "read" || check.action.purpose === "reconcile") return refuse("connect/effect-mismatch", "No.");
        if (checks && check.action.environment !== kind) return refuse("connect/environment-mismatch", "Another environment.");
        performed++;
        return { status: "ok", output: {} };
      },
    };
    return { port, performed: () => performed };
  }
  const caseOf = (port: ActionPort, options: Partial<Parameters<typeof actionPortConformance>[1]> = {}) =>
    actionPortConformance(port, { read: { action: "notes.get", input: {} }, ...options }).find((c) => c.name === "refuses a connection that serves another kind of environment")!;

  it("is checked by the conformance suite: a port that ignores it fails, one that checks it passes", async () => {
    for (const kind of ENVIRONMENT_KINDS) {
      await caseOf(onePort(kind, true).port, { environment: kind }).run();
      const careless = onePort(kind, false);
      await expect(caseOf(careless.port, { environment: kind, performed: careless.performed }).run()).rejects.toThrow(/expected a refusal/);
    }
    // A resolver that finds no connection of that kind may say so instead.
    const none: ActionPort = { run: async (value) => ((value as { environment: string }).environment === "production" ? { status: "ok", output: {} } : refuse("connect/no-connection", "None.")) };
    await caseOf(none).run();
  });

  it("needs at least one foreign kind, never the port's own", async () => {
    const { port } = onePort("preview", true);
    await expect(caseOf(port, { environment: "preview", foreignEnvironments: [] }).run()).rejects.toThrow(/at least one kind/);
    await expect(caseOf(port, { environment: "preview", foreignEnvironments: ["preview", "test"] }).run()).rejects.toThrow(/own kind/);
    await caseOf(port, { environment: "preview", foreignEnvironments: ["test"] }).run();
  });
});

describe("contract-version discovery", () => {
  const NOW = Date.UTC(2026, 9, 8);

  it("describes ports with distinct positive versions, and picks the highest both serve", () => {
    expect(ACTION_CONTRACT_VERSIONS).toEqual([ACTION_CONTRACT_VERSION]);
    for (const ok of [{ contracts: [1] }, { contracts: [1, 2, 9] }, { contracts: [3], extra: "later fields are allowed" }]) expect(isActionPortDescription(ok)).toBe(true);
    for (const bad of [null, [], {}, { contracts: [] }, { contracts: [0] }, { contracts: [1, 1] }, { contracts: [1.5] }, { contracts: ["1"] }, { contracts: Array.from({ length: 65 }, (_, i) => i + 1) }]) {
      expect(isActionPortDescription(bad)).toBe(false);
    }
    expect(pickContractVersion([1, 2, 3], [2, 3, 4])).toBe(3);
    expect(pickContractVersion([1], [2])).toBeNull();
    expect(pickContractVersion([1, 2], [1])).toBe(1);
  });

  it("refuses an unsupported version as retryable, after 30 s", () => {
    expect(CONNECT_REFUSALS["connect/contract-unsupported"]).toBe("retryable");
    expect(CONTRACT_UNSUPPORTED_RETRY_MS).toBe(30_000);
    const a = { ...draftApprovedAction({ action: "notes.get", effect: "read", input: {}, now: NOW }), contract: 2 };
    expect(checkApprovedAction(a, { now: NOW })).toMatchObject({ ok: false, outcome: { status: "retryable", error: { code: "connect/contract-unsupported" }, retryAfterMs: 30_000 } });
  });

  /** A port that serves contract 1 and describes itself with `description`; `strict` refuses other versions. */
  function describing(description: unknown, strict = true): ActionPort {
    return {
      async run(value) {
        if (!strict && (value as { contract?: unknown }).contract !== 1) return { status: "ok", output: {} };
        const check = await verifyApprovedAction(value, { now: Date.now(), audience: CONFORMANCE_AUDIENCE, verifier: conformanceVerifier() });
        return check.ok ? { status: "ok", output: {} } : check.outcome;
      },
      describe: () => description as { contracts: number[] },
    };
  }
  const NAME = "describes the contract versions it serves, and refuses one it does not";
  const caseOf = (port: ActionPort) => actionPortConformance(port, { read: { action: "notes.get", input: {} } }).find((c) => c.name === NAME);

  it("is checked by the conformance suite for a port that describes itself", async () => {
    await caseOf(describing({ contracts: [1] }))!.run();
    await expect(caseOf(describing({ contracts: [] }))!.run()).rejects.toThrow(/describe answered/);
    await expect(caseOf(describing({ contracts: [3] }))!.run()).rejects.toThrow(/does not list contract 1/);
    await expect(caseOf(describing({ contracts: [1] }, false))!.run()).rejects.toThrow(/expected a refusal/);
    const throwing: ActionPort = { run: async () => ({ status: "ok", output: {} }), describe: () => { throw new Error("down"); } };
    await expect(caseOf(throwing)!.run()).rejects.toThrow(/describe threw/);
    // A port that does not describe itself has no such case.
    expect(caseOf({ run: async () => ({ status: "ok", output: {} }) })).toBeUndefined();
  });
});

describe("the traceparent", () => {
  const NOW = Date.UTC(2026, 9, 8);
  const T1 = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

  it("is a W3C traceparent: lower-case hex, not version ff, neither id all zeros", () => {
    expect(TRACEPARENT_RE.test(T1)).toBe(true);
    for (const ok of [T1, "01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-00", "fe-00000000000000000000000000000001-0000000000000001-ff"]) expect(isTraceparent(ok)).toBe(true);
    const bad = [
      T1.toUpperCase(),
      `ff${T1.slice(2)}`,
      `00-${"0".repeat(32)}-00f067aa0ba902b7-01`,
      `00-4bf92f3577b34da6a3ce929d0e0e4736-${"0".repeat(16)}-01`,
      `${T1}-extra`,
      ` ${T1}`,
      `${T1}\n`,
      T1.slice(0, -1),
      "00-4bf92f3577b34da6a3ce929d0e0e473-600f067aa0ba902b7-01",
      "",
      null,
      undefined,
      7,
      { traceparent: T1 },
    ];
    for (const value of bad) expect(isTraceparent(value)).toBe(false);
  });

  it("is signed: changing, adding or removing it breaks the proof, and an envelope without one signs as before", async () => {
    const plain = draftApprovedAction({ action: "notes.get", effect: "read", input: {}, now: NOW });
    expect(plain).not.toHaveProperty("traceparent");
    const traced = draftApprovedAction({ action: "notes.get", effect: "read", input: {}, now: NOW, traceparent: T1 });
    expect(traced.traceparent).toBe(T1);
    // Only the field differs, so an envelope without it carries the signature it always had.
    const { traceparent: _dropped, ...stripped } = traced;
    expect(sealApprovedAction(stripped).proof).toEqual(plain.proof);
    const options = { now: NOW, audience: CONFORMANCE_AUDIENCE, verifier: conformanceVerifier() };
    expect((await verifyApprovedAction(traced, options)).ok).toBe(true);
    const changed = `00-${"1".repeat(32)}-00f067aa0ba902b7-01`;
    for (const forged of [{ ...traced, traceparent: changed }, stripped, { ...plain, traceparent: T1 }]) {
      expect(await verifyApprovedAction(forged, options)).toMatchObject({ ok: false, outcome: { status: "final", error: { code: "connect/proof-invalid" } } });
    }
  });

  it("is never a reason to refuse an envelope", () => {
    for (const value of ["not-a-traceparent", T1.toUpperCase(), 7]) {
      const a = sealApprovedAction({ ...draftApprovedAction({ action: "notes.get", effect: "read", input: {}, now: NOW }), traceparent: value as string });
      expect(checkApprovedAction(a, { now: NOW }).ok).toBe(true);
    }
  });

  it("is checked by the conformance suite: a port that refuses a malformed one fails", async () => {
    const NAME = "performs a read whatever its traceparent";
    const strict: ActionPort = {
      async run(value) {
        const check = await verifyApprovedAction(value, { now: Date.now(), audience: CONFORMANCE_AUDIENCE, verifier: conformanceVerifier() });
        if (!check.ok) return check.outcome;
        if (check.action.traceparent !== undefined && !isTraceparent(check.action.traceparent)) return refuse("connect/invalid-envelope", "Bad trace.");
        return { status: "ok", output: {} };
      },
    };
    const caseOf = (port: ActionPort) => actionPortConformance(port, { read: { action: "notes.get", input: {} } }).find((c) => c.name === NAME)!;
    await expect(caseOf(strict).run()).rejects.toThrow(/malformed traceparent: expected ok/);
    const lenient: ActionPort = {
      async run(value) {
        const check = await verifyApprovedAction(value, { now: Date.now(), audience: CONFORMANCE_AUDIENCE, verifier: conformanceVerifier() });
        return check.ok ? { status: "ok", output: {} } : check.outcome;
      },
    };
    await caseOf(lenient).run();
  });
});

describe("the actor's and the approver's authTime", () => {
  const NOW = Date.UTC(2026, 9, 8);
  const SIGNED_IN = NOW - 5 * 60 * 1000;
  const reviewed = () => draftApprovedAction({ action: "notes.delete", effect: "write", input: { id: "n-1" }, now: NOW, risk: "confirm", idempotent: true });
  /** The draft with `authTime` on its actor and its approval's `by`, as the engine sends it, sealed. */
  const withAuthTimes = (actorTime: unknown, byTime: unknown) => {
    const { proof: _proof, ...a } = reviewed();
    return sealApprovedAction({ ...a, actor: { ...a.actor!, authTime: actorTime as number }, approval: { ...a.approval!, by: { ...a.approval!.by, authTime: byTime as number } } });
  };

  it("is a time when present, on the actor and on the approval's by, and anything else is malformed", () => {
    expect(checkApprovedAction(withAuthTimes(SIGNED_IN, SIGNED_IN), { now: NOW }).ok).toBe(true);
    expect(checkApprovedAction(withAuthTimes(0, NOW), { now: NOW }).ok).toBe(true);
    for (const bad of [-1, Number.NaN, "2026-10-08T09:00:00Z", null, {}]) {
      for (const env of [withAuthTimes(bad, SIGNED_IN), withAuthTimes(SIGNED_IN, bad)]) {
        expect(checkApprovedAction(env, { now: NOW })).toMatchObject({ ok: false, outcome: { status: "final", error: { code: "connect/invalid-envelope" } } });
      }
    }
  });

  it("is signed, and an envelope without it signs as before", async () => {
    const plain = reviewed();
    expect(plain.actor).not.toHaveProperty("authTime");
    expect(plain.approval!.by).not.toHaveProperty("authTime");
    const timed = withAuthTimes(SIGNED_IN, SIGNED_IN);
    expect(timed.proof).not.toEqual(plain.proof);
    const options = { now: NOW, audience: CONFORMANCE_AUDIENCE, verifier: conformanceVerifier() };
    expect((await verifyApprovedAction(timed, options)).ok).toBe(true);
    // Removing it from either place gives back exactly the envelope without it, signature included.
    const { authTime: _a, ...actor } = timed.actor!;
    const { authTime: _b, ...by } = timed.approval!.by;
    const { proof: _p, ...unsigned } = timed;
    expect(sealApprovedAction({ ...unsigned, actor, approval: { ...timed.approval!, by } })).toEqual(plain);
    for (const forged of [{ ...timed, actor: { ...timed.actor!, authTime: NOW } }, { ...timed, actor }, { ...timed, approval: { ...timed.approval!, by } }]) {
      expect(await verifyApprovedAction(forged, options)).toMatchObject({ ok: false, outcome: { status: "final", error: { code: "connect/proof-invalid" } } });
    }
  });
});
