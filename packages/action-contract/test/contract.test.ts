import { createHash } from "node:crypto";
import { describe, expect, expectTypeOf, it } from "vitest";
import { ACTION_CONTRACT_VERSION, APPROVED_ACTION_SIGNING_TAG, CONNECT_REFUSALS, DEFAULT_CLOCK_SKEW_MS, MAX_ACTION_OUTPUT_BYTES, MAX_ACTION_TIMEOUT_MS, UNSIGNED_PROOF, approvalBinding, approvedActionSigningBytes, checkApprovedAction, hmacActionSigner, hmacActionVerifier, signApprovedAction, verifyApprovedAction, isActionOutcome, isDeliverConnection, isDeliverRequest, isOperationContract, isRefusalCode, isSha256Digest, normalizeOutcome, operationDigest, refuse, riskAtLeast, sha256Digest, type ActionOutcome, type ActionPort, type ApprovedAction, type JsonObject, type OperationContract } from "../src/index.js";
import { CONFORMANCE_AUDIENCE, CONFORMANCE_KEY, actionPortConformance, conformanceVerifier, draftApproval, draftApprovedAction, sealApprovedAction } from "../src/api/conformance.js";

const NOW = Date.UTC(2026, 9, 7);
const contract: OperationContract = {
  effect: "write",
  idempotent: true,
  irreversible: false,
  compensate: "notes.delete",
  riskFloor: "confirm",
  input: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
  output: { type: "object" },
};

const refusal = (check: ReturnType<typeof checkApprovedAction>) => (check.ok ? "ok" : `${check.outcome.status}:${"error" in check.outcome ? check.outcome.error.code : ""}`);

describe("digests", () => {
  it("are sha256 of the canonical JSON, whatever the key order", () => {
    const hex = createHash("sha256").update('{"a":1,"b":[true,null]}').digest("hex");
    expect(sha256Digest({ b: [true, null], a: 1 })).toBe(`sha256:${hex}`);
    expect(isSha256Digest(`sha256:${hex}`)).toBe(true);
    for (const bad of ["sha256:", `sha256:${hex.toUpperCase()}`, `sha1:${hex}`, 7, null]) expect(isSha256Digest(bad)).toBe(false);
  });

  it("of an operation contract cover what it promises, not how it is written", () => {
    const digest = operationDigest(contract);
    const reordered = JSON.parse(JSON.stringify({ output: contract.output, riskFloor: "confirm", input: contract.input, compensate: "notes.delete", irreversible: false, idempotent: true, effect: "write" })) as OperationContract;
    expect(operationDigest(reordered)).toBe(digest);
    const { compensate: _drop, ...noUndo } = contract;
    for (const changed of [
      { ...contract, riskFloor: "approval" as const },
      { ...contract, idempotent: false },
      { ...contract, irreversible: true },
      noUndo,
      { ...contract, input: { ...contract.input, required: [] } },
      { ...contract, output: { type: "array" as const } },
    ]) {
      expect(operationDigest(changed)).not.toBe(digest);
    }
    expect(isOperationContract(contract)).toBe(true);
    expect(isOperationContract({ ...contract, extra: 1 })).toBe(false);
    expect(isOperationContract({ ...contract, input: { type: "string" } })).toBe(false);
    expect(isOperationContract({ ...contract, riskFloor: "high" })).toBe(false);
    expect(isOperationContract({ ...contract, input: { type: "object", pattern: "(a)\\1" } })).toBe(false);
  });
});

describe("normalizeOutcome", () => {
  it("fails a read whose output is over the cap, and withholds a write's, which stays applied", () => {
    const big = { text: "x".repeat(MAX_ACTION_OUTPUT_BYTES) };
    const bytes = JSON.stringify(big).length;
    expect(normalizeOutcome({ status: "ok", output: big }, "read")).toEqual({
      status: "final",
      error: { code: "flow/output-too-large", message: "The answer was too large to use.", detail: `${bytes} bytes; at most ${MAX_ACTION_OUTPUT_BYTES} are kept` },
    });
    expect(normalizeOutcome({ status: "ok", output: big }, "write")).toEqual({ status: "ok", output: null, withheld: { bytes } });
    // Exactly at the cap is kept; the cap can be lowered.
    const at = { t: "y".repeat(MAX_ACTION_OUTPUT_BYTES - 8) };
    expect(JSON.stringify(at).length).toBe(MAX_ACTION_OUTPUT_BYTES);
    expect(normalizeOutcome({ status: "ok", output: at }, "read")).toEqual({ status: "ok", output: at });
    expect(normalizeOutcome({ status: "ok", output: { a: "four" } }, "write", { maxOutputBytes: 5 })).toEqual({ status: "ok", output: null, withheld: { bytes: 12 } });
    // A performer that already withheld it says so; a claim beside a real output, or a malformed one, is ignored.
    expect(normalizeOutcome({ status: "ok", output: null, withheld: { bytes: 9_000_000 } }, "write")).toEqual({ status: "ok", output: null, withheld: { bytes: 9_000_000 } });
    expect(normalizeOutcome({ status: "ok", output: null, withheld: { bytes: 9_000_000 } }, "read")).toMatchObject({ status: "final", error: { code: "flow/output-too-large" } });
    expect(normalizeOutcome({ status: "ok", output: { a: 1 }, withheld: { bytes: 9 } }, "write")).toEqual({ status: "ok", output: { a: 1 } });
    for (const withheld of [{ bytes: -1 }, { bytes: 1.5 }, { bytes: "9" }, [9], 9]) expect(normalizeOutcome({ status: "ok", output: null, withheld }, "write")).toEqual({ status: "ok", output: null });
  });

  it("never throws, whatever the status is: anything that is not an outcome is the effect's fallback", () => {
    const throwing = { get status(): string { throw new Error("boom"); } };
    const stringy = { toString: () => { throw new Error("boom"); } };
    const proxy = new Proxy({}, { get: () => { throw new Error("boom"); }, ownKeys: () => { throw new Error("boom"); } });
    const statuses: unknown[] = [Object.create(null), stringy, 7, null, Symbol("ok"), ["ok"], { toString: () => "ok" }, "OK", ""];
    const malformed: unknown[] = [throwing, proxy, ...statuses.map((status) => ({ status }))];
    for (const raw of malformed) {
      expect(isActionOutcome(raw)).toBe(false);
      expect(normalizeOutcome(raw, "write")).toEqual({ status: "unknown", error: { code: "flow/bad-outcome", message: "The service answered strangely." } });
      expect(normalizeOutcome(raw, "read")).toEqual({ status: "retryable", error: { code: "flow/bad-outcome", message: "The service answered strangely." } });
    }
    // Not plain JSON anywhere, or not an object: not an outcome either.
    for (const raw of [{ status: "ok", output: { n: Number.NaN } }, { status: "final", error: { code: () => 1 } }, "ok", null, undefined]) expect(isActionOutcome(raw)).toBe(false);
    for (const status of ["ok", "retryable", "final", "unknown", "pending"]) expect(isActionOutcome({ status })).toBe(true);
  });

  it("narrows what it accepts to an outcome, so a caller needs no cast", () => {
    const raw: unknown = JSON.parse('{"status":"ok","output":1}');
    if (!isActionOutcome(raw)) expect.unreachable("an outcome was refused");
    expectTypeOf(raw).toEqualTypeOf<ActionOutcome>();
    expect(raw.status).toBe("ok");
  });

  it("keeps a well-formed pending ref and a rate-limit bucket, and drops malformed ones", () => {
    expect(normalizeOutcome({ status: "pending", ref: "job_42" }, "write")).toEqual({ status: "pending", ref: "job_42" });
    expect(normalizeOutcome({ status: "pending", ref: "has space" }, "write")).toEqual({ status: "pending" });
    expect(normalizeOutcome({ status: "pending", ref: "x".repeat(257) }, "write")).toEqual({ status: "pending" });
    expect(normalizeOutcome({ status: "pending", ref: 7 }, "write")).toEqual({ status: "pending" });
    expect(normalizeOutcome({ status: "retryable", error: { code: "c", message: "m" }, retryAfterMs: 10, limit: "connection" }, "read")).toEqual({
      status: "retryable",
      error: { code: "c", message: "m" },
      retryAfterMs: 10,
      limit: "connection",
    });
    expect(normalizeOutcome({ status: "retryable", error: { code: "c", message: "m" }, limit: "everyone" }, "read")).toEqual({ status: "retryable", error: { code: "c", message: "m" } });
  });

  it("treats anything malformed as retryable for a read and unknown for a write", () => {
    for (const raw of [null, "ok", { status: "done" }, { status: "ok", output: () => 1 }]) {
      expect(normalizeOutcome(raw, "read").status).toBe("retryable");
      expect(normalizeOutcome(raw, "write").status).toBe("unknown");
    }
  });
});

describe("refusals", () => {
  it("are final or retryable, never unknown", () => {
    for (const [code, kind] of Object.entries(CONNECT_REFUSALS)) {
      expect(["final", "retryable"]).toContain(kind);
      expect(code.startsWith("connect/")).toBe(true);
      expect(isRefusalCode(code)).toBe(true);
      const outcome = refuse(code as keyof typeof CONNECT_REFUSALS, "No.", { detail: "staff only", retryAfterMs: 5 });
      expect(outcome.status).toBe(kind);
      expect(outcome).toMatchObject({ error: { code, message: "No.", detail: "staff only" } });
      if (outcome.status === "retryable") expect(outcome.retryAfterMs).toBe(5);
    }
    // A rate-limited refusal names its bucket; a final one has none.
    expect(refuse("connect/rate-limited", "Slow down.", { retryAfterMs: 30_000, limit: "connection" })).toEqual({ status: "retryable", error: { code: "connect/rate-limited", message: "Slow down." }, retryAfterMs: 30_000, limit: "connection" });
    expect(refuse("connect/rate-limited", "Slow down.", { limit: "everyone" as never })).toEqual({ status: "retryable", error: { code: "connect/rate-limited", message: "Slow down." } });
    expect(refuse("connect/disabled", "Off.", { limit: "connector" })).toEqual({ status: "final", error: { code: "connect/disabled", message: "Off." } });
    expect(Object.keys(CONNECT_REFUSALS)).toEqual(expect.arrayContaining(["connect/contract-unsupported", "connect/expired", "connect/approval-invalid", "connect/rate-limited", "connect/unavailable"]));
    expect(isRefusalCode("connect/internal")).toBe(false);
    expect(isRefusalCode("toString")).toBe(false);
    expect(riskAtLeast("approval", "confirm") && riskAtLeast("none", "none") && !riskAtLeast("confirm", "approval")).toBe(true);
  });
});

describe("checkApprovedAction", () => {
  const good = (over: Partial<Parameters<typeof draftApprovedAction>[0]> = {}): ApprovedAction =>
    draftApprovedAction({ action: "notes.create", effect: "write", input: { title: "Hi" }, now: NOW, risk: "confirm", contract: operationDigest(contract), ...over });

  it("accepts a draft, tolerates unknown fields, and returns a detached copy", () => {
    const a = { ...good(), futureField: { x: 1 } };
    const check = checkApprovedAction(a, { now: NOW });
    expect(check.ok).toBe(true);
    if (!check.ok) return;
    expect(check.action).toEqual(a);
    expect(check.action).not.toBe(a);
    a.input.title = "changed";
    expect(check.action.input.title).toBe("Hi");
    expect(a.contract).toBe(ACTION_CONTRACT_VERSION);
  });

  it("refuses in the documented order and with the documented codes", () => {
    const a = good();
    const cases: Array<[string, unknown, string]> = [
      ["not an object", "envelope", "final:connect/invalid-envelope"],
      ["no contract", { ...a, contract: undefined }, "final:connect/invalid-envelope"],
      ["contract 2", { ...a, contract: 2 }, "retryable:connect/contract-unsupported"],
      ["contract 2 even when malformed", { contract: 2 }, "retryable:connect/contract-unsupported"],
      ["not plain JSON", { ...a, input: { title: () => "x" } }, "final:connect/invalid-envelope"],
      ["a cycle", (() => { const c: Record<string, unknown> = { ...a }; c.self = c; return c; })(), "final:connect/invalid-envelope"],
      ["attempt 0", { ...a, attempt: 0 }, "final:connect/invalid-envelope"],
      ["environment", { ...a, environment: "staging" }, "final:connect/invalid-envelope"],
      ["actor kind", { ...a, actor: { domain: "member", id: "m", kind: "root" } }, "final:connect/invalid-envelope"],
      ["approval roles", { ...a, approval: { ...a.approval!, by: { ...a.approval!.by, roles: [1] } } }, "final:connect/invalid-envelope"],
      ["pin", { ...a, action: { ...a.action, contract: "sha256:00" } }, "final:connect/invalid-envelope"],
      ["no causedBy", { ...a, origin: (({ causedBy: _dropped, ...rest }) => rest)(a.origin) }, "final:connect/invalid-envelope"],
      ["causedBy kind", { ...a, origin: { ...a.origin, causedBy: { domain: "member", id: "m", kind: "root" } } }, "final:connect/invalid-envelope"],
      ["no audience", { ...a, audience: undefined }, "final:connect/invalid-envelope"],
      ["no issuedAt", { ...a, issuedAt: "today" }, "final:connect/invalid-envelope"],
      ["malformed proof", { ...a, proof: { alg: "HS256", keyId: "k" } }, "final:connect/invalid-envelope"],
      ["approval without binding", { ...a, approval: (({ binding: _dropped, ...rest }) => rest)(a.approval!) }, "final:connect/invalid-envelope"],
      ["timeout over 7 days", { ...a, timeoutMs: MAX_ACTION_TIMEOUT_MS + 1, deadline: NOW + 1000 }, "final:connect/invalid-envelope"],
      ["due later than issued + timeout", { ...a, deadline: a.issuedAt + a.timeoutMs + 1 }, "final:connect/invalid-envelope"],
      ["issued in the future", { ...a, issuedAt: NOW + DEFAULT_CLOCK_SKEW_MS + 1, deadline: NOW + DEFAULT_CLOCK_SKEW_MS + 2 }, "retryable:connect/clock-skew"],
      ["deadline passed", { ...a, deadline: NOW }, "retryable:connect/late"],
      ["approval expired", { ...a, approval: { ...a.approval!, notAfter: NOW } }, "final:connect/expired"],
      ["input changed", { ...a, input: { title: "Other" } }, "final:connect/invalid-input"],
      ["no review", (({ approval: _dropped, ...rest }) => rest)(a), "final:connect/approval-invalid"],
      ["a field set to undefined", { ...a, approval: undefined }, "final:connect/invalid-envelope"],
      ["review of the wrong kind", { ...a, approval: { ...a.approval!, kind: "approval" } }, "final:connect/approval-invalid"],
      ["review of other input", { ...a, approval: { ...a.approval!, inputDigest: sha256Digest({ title: "Other" }) } }, "final:connect/approval-invalid"],
      ["review bound to another run", { ...a, origin: { ...a.origin, runId: "run-other" } }, "final:connect/approval-invalid"],
      ["review bound to another item", { ...a, origin: { ...a.origin, item: "row-2" } }, "final:connect/approval-invalid"],
      ["review bound to another action", { ...a, approval: draftApproval({ action: "notes.delete", input: a.input }) }, "final:connect/approval-invalid"],
      ["approved by the run's own person", { ...good({ risk: "approval" }), approval: { ...good({ risk: "approval" }).approval!, by: { domain: "member", id: "conformance-subject" } } }, "final:connect/approval-invalid"],
    ];
    for (const [name, value, expected] of cases) expect(`${name}: ${refusal(checkApprovedAction(value, { now: NOW }))}`).toBe(`${name}: ${expected}`);
    expect(checkApprovedAction(good({ causedBy: null }), { now: NOW }).ok).toBe(true);
    // Issued a little ahead of this clock, within the skew allowed.
    expect(checkApprovedAction(good({ now: NOW + DEFAULT_CLOCK_SKEW_MS }), { now: NOW }).ok).toBe(true);
    expect(refusal(checkApprovedAction(good({ now: NOW + 5_000 }), { now: NOW, skewMs: 1_000 }))).toBe("retryable:connect/clock-skew");
    // Evidence bound to its item is accepted for that item.
    const perItem = good({ approval: draftApproval({ action: "notes.create", input: { title: "Hi" }, item: "row-1" }) });
    expect(checkApprovedAction({ ...perItem, origin: { ...perItem.origin, item: "row-1" } }, { now: NOW }).ok).toBe(true);
    // A compensation needs no review; neither does a read.
    expect(checkApprovedAction(good({ purpose: "compensate", risk: "none", approval: null }), { now: NOW }).ok).toBe(true);
    expect(checkApprovedAction(good({ effect: "read", risk: "none" }), { now: NOW }).ok).toBe(true);
  });

  it("needs an undo or a check to name its target, a check to be a read and an undo a write", () => {
    const undo = good({ purpose: "compensate", risk: "none", approval: null, idempotent: true });
    expect(undo.target).toBe("effect-conformance-target");
    expect(checkApprovedAction(undo, { now: NOW }).ok).toBe(true);
    expect(refusal(checkApprovedAction(good({ purpose: "compensate", risk: "none", approval: null, target: null }), { now: NOW }))).toBe("final:connect/invalid-envelope");
    expect(refusal(checkApprovedAction(good({ effect: "read", risk: "none", purpose: "reconcile", target: null }), { now: NOW }))).toBe("final:connect/invalid-envelope");
    // A reconcile sent as a write, unreviewed: whatever the action, a check only reads.
    expect(refusal(checkApprovedAction(good({ purpose: "reconcile", risk: "none", approval: null }), { now: NOW }))).toBe("final:connect/effect-mismatch");
    expect(refusal(checkApprovedAction(good({ effect: "read", purpose: "compensate", risk: "none" }), { now: NOW }))).toBe("final:connect/effect-mismatch");
    expect(checkApprovedAction(good({ effect: "read", risk: "none", purpose: "reconcile" }), { now: NOW }).ok).toBe(true);
    // A run may name no target.
    expect(good().target).toBeUndefined();
  });

  it("needs an undo to name the write it undoes, to need no review and to de-duplicate", () => {
    const undo = good({ purpose: "compensate", risk: "none", approval: null, idempotent: true, undoes: "notes.create" });
    expect(undo.undoes).toBe("notes.create");
    expect(checkApprovedAction(undo, { now: NOW }).ok).toBe(true);
    expect(refusal(checkApprovedAction(good({ purpose: "compensate", risk: "none", approval: null, undoes: null }), { now: NOW }))).toBe("final:connect/invalid-envelope");
    expect(refusal(checkApprovedAction({ ...good(), undoes: "notes.create" }, { now: NOW }))).toBe("final:connect/invalid-envelope");
    expect(refusal(checkApprovedAction({ ...good({ effect: "read", purpose: "reconcile" }), undoes: "notes.create" }, { now: NOW }))).toBe("final:connect/invalid-envelope");
    // What the engine states when it knows the undo's own contract.
    expect(refusal(checkApprovedAction(good({ purpose: "compensate", risk: "confirm", approval: null, undoes: "notes.create" }), { now: NOW }))).toBe("final:connect/approval-invalid");
    expect(refusal(checkApprovedAction(good({ purpose: "compensate", risk: "approval", approval: null, undoes: "notes.create" }), { now: NOW }))).toBe("final:connect/approval-invalid");
    expect(refusal(checkApprovedAction(good({ purpose: "compensate", risk: "none", approval: null, idempotent: false, undoes: "notes.create" }), { now: NOW }))).toBe("final:connect/idempotency-mismatch");
  });

  it("never throws, even for a hostile value", () => {
    const hostile = Object.defineProperty({ ...good() }, "input", {
      enumerable: true,
      get() {
        throw new Error("boom");
      },
    });
    expect(refusal(checkApprovedAction(hostile, { now: NOW }))).toBe("final:connect/invalid-envelope");
    const proxy = new Proxy({}, { ownKeys: () => { throw new Error("boom"); }, get: () => 1 });
    expect(refusal(checkApprovedAction(proxy, { now: NOW }))).toBe("final:connect/invalid-envelope");
  });
});

describe("verifyApprovedAction and signing", () => {
  const good = (over: Partial<Parameters<typeof draftApprovedAction>[0]> = {}): ApprovedAction =>
    draftApprovedAction({ action: "notes.create", effect: "write", input: { title: "Hi" }, now: NOW, risk: "confirm", ...over });
  const options = { now: NOW, audience: CONFORMANCE_AUDIENCE, verifier: conformanceVerifier() };
  const verified = async (value: unknown, over: Partial<typeof options> = {}) => refusal(await verifyApprovedAction(value, { ...options, ...over }));

  it("accepts an envelope signed for this performer and returns a detached copy", async () => {
    const a = good();
    expect(a.proof).toMatchObject({ alg: "HS256", keyId: CONFORMANCE_KEY.keyId });
    const check = await verifyApprovedAction(a, options);
    expect(check.ok).toBe(true);
    if (check.ok) expect(check.action).not.toBe(a);
  });

  it("refuses an envelope for another performer, unsigned, or changed after it was signed", async () => {
    const a = good();
    expect(await verified(a, { audience: "other-performer" })).toBe("final:connect/wrong-audience");
    expect(await verified({ ...a, proof: { ...UNSIGNED_PROOF } })).toBe("final:connect/proof-invalid");
    expect(await verified(good({ key: null }))).toBe("final:connect/proof-invalid");
    // Every field is covered: none can be changed or moved without the key.
    const changed: Array<[string, ApprovedAction]> = [
      ["scope", { ...a, scope: { ...a.scope, tenantId: "tenant-other" } }],
      ["subject", { ...a, subject: { domain: "member", id: "someone-else" } }],
      ["effectId", { ...a, effectId: "effect-other" }],
      ["attempt", { ...a, attempt: 2 }],
      ["causedBy", { ...a, origin: { ...a.origin, causedBy: null } }],
      ["issuedAt", { ...a, issuedAt: a.issuedAt + 1 }],
      ["deadline", { ...a, deadline: a.deadline - 1 }],
      ["a later field", { ...a, ...({ futureField: 1 } as object) } as ApprovedAction],
    ];
    for (const [name, value] of changed) expect(`${name}: ${await verified(value)}`).toBe(`${name}: final:connect/proof-invalid`);
    // Signed by a key this performer does not hold, or under another algorithm name.
    expect(await verified(sealApprovedAction(a, { keyId: "stranger", secret: "s".repeat(32) }))).toBe("final:connect/proof-invalid");
    expect(await verified(sealApprovedAction(a, { keyId: CONFORMANCE_KEY.keyId, secret: "s".repeat(32) }))).toBe("final:connect/proof-invalid");
    expect(await verified({ ...a, proof: { ...a.proof, alg: "EdDSA" } })).toBe("final:connect/proof-invalid");
  });

  it("checks the envelope before the proof, and answers a failing verifier as unavailable", async () => {
    let asked = 0;
    const counting = { verify: () => (asked++, true) };
    expect(await verified({ ...good(), deadline: NOW }, { verifier: counting })).toBe("retryable:connect/late");
    expect(await verified({ ...good(), proof: undefined }, { verifier: counting })).toBe("final:connect/invalid-envelope");
    expect(asked).toBe(0);
    const throwing = { verify: () => { throw new Error("kms down"); } };
    expect(await verified(good(), { verifier: throwing })).toBe("retryable:connect/unavailable");
    expect(await verified(good(), { verifier: { verify: () => Promise.reject(new Error("down")) } })).toBe("retryable:connect/unavailable");
    // Only `true` verifies.
    expect(await verified(good(), { verifier: { verify: () => "yes" as unknown as boolean } })).toBe("final:connect/proof-invalid");
    // The verifier is told the audience and scope, and is given copies.
    let seen: unknown;
    await verifyApprovedAction(good(), { ...options, verifier: { verify: (_bytes, proof, context) => ((seen = { proof, context }), true) } });
    expect(seen).toEqual({ proof: good().proof, context: { audience: CONFORMANCE_AUDIENCE, scope: good().scope } });
  });

  it("signs the tagged canonical envelope without its proof", async () => {
    const a = good();
    const text = new TextDecoder().decode(approvedActionSigningBytes(a));
    expect(text.startsWith(APPROVED_ACTION_SIGNING_TAG)).toBe(true);
    expect(text).not.toContain("proof");
    const reordered = Object.fromEntries(Object.entries(a).reverse());
    expect(approvedActionSigningBytes(reordered)).toEqual(approvedActionSigningBytes(a));
    const { proof: _proof, ...unsigned } = a;
    const signed = await signApprovedAction<ApprovedAction>(unsigned, hmacActionSigner(CONFORMANCE_KEY));
    expect(signed.proof).toEqual(a.proof);
    // An async signer (a KMS) works the same; a malformed answer throws.
    const later = await signApprovedAction<ApprovedAction>(unsigned, { sign: async (bytes) => hmacActionSigner(CONFORMANCE_KEY).sign(bytes) });
    expect(later.proof).toEqual(a.proof);
    await expect(signApprovedAction<ApprovedAction>(unsigned, { sign: () => ({ alg: "HS256", keyId: "", sig: "x" }) })).rejects.toThrow(/malformed proof/);
  });

  it("rotates keys by key id and refuses short secrets", async () => {
    const next = { keyId: "next", secret: "n".repeat(32) };
    const rotating = hmacActionVerifier({ [CONFORMANCE_KEY.keyId]: CONFORMANCE_KEY.secret, next: next.secret });
    expect(await verified(good(), { verifier: rotating })).toBe("ok");
    expect(await verified(sealApprovedAction(good(), next), { verifier: rotating })).toBe("ok");
    expect(await verified(sealApprovedAction(good(), { keyId: "toString", secret: "t".repeat(32) }), { verifier: rotating })).toBe("final:connect/proof-invalid");
    expect(() => hmacActionSigner({ keyId: "k", secret: "short" })).toThrow(/32 bytes/);
    expect(() => hmacActionVerifier({ k: "short" })).toThrow(/32 bytes/);
    expect(() => hmacActionSigner({ keyId: "", secret: "s".repeat(32) })).toThrow(/keyId/);
  });

  it("binds review evidence to the action, run, name, item and input", () => {
    const parts = { action: "notes.create", runId: "run-1", name: "create", inputDigest: sha256Digest({ title: "Hi" }) };
    const base = approvalBinding(parts);
    expect(approvalBinding({ ...parts })).toBe(base);
    for (const other of [
      { ...parts, action: "notes.delete" },
      { ...parts, runId: "run-2" },
      { ...parts, name: "create2" },
      { ...parts, item: "row-1" },
      { ...parts, inputDigest: sha256Digest({ title: "Other" }) },
    ]) expect(approvalBinding(other)).not.toBe(base);
  });
});

describe("actionPortConformance", () => {
  const read = { action: "notes.get", input: { id: "n-1" } as JsonObject };
  const write = { action: "notes.create", input: { title: "Hi" } as JsonObject, risk: "confirm" as const };
  // Each write names the undo it declares; an undo states its own risk floor and idempotency.
  const served = new Map<string, { effect: "read" | "write"; digest: ReturnType<typeof sha256Digest>; compensate?: string; riskFloor?: "none" | "confirm" | "approval"; idempotent?: boolean }>([
    ["notes.get", { effect: "read", digest: sha256Digest({ op: "get" }) }],
    ["notes.create", { effect: "write", digest: sha256Digest({ op: "create" }), compensate: "notes.delete" }],
    ["notes.delete", { effect: "write", digest: sha256Digest({ op: "delete" }), idempotent: true }],
    ["notes.share", { effect: "write", digest: sha256Digest({ op: "share" }), compensate: "notes.unshare" }],
    ["notes.unshare", { effect: "write", digest: sha256Digest({ op: "unshare" }), idempotent: true, riskFloor: "confirm" }],
    ["notes.pin", { effect: "write", digest: sha256Digest({ op: "pin" }), compensate: "notes.unpin" }],
    ["notes.unpin", { effect: "write", digest: sha256Digest({ op: "unpin" }), idempotent: false }],
  ]);
  const undos = [
    { action: "notes.delete", input: { id: "n-1" } as JsonObject, undoes: "notes.create" },
    { action: "notes.unshare", input: { id: "n-1" } as JsonObject, undoes: "notes.share", risk: "confirm" as const },
    { action: "notes.unpin", input: { id: "n-1" } as JsonObject, undoes: "notes.pin", idempotent: false },
  ];

  /** A minimal performer that follows the contract. */
  function referencePort(): { port: ActionPort; performed: () => number } {
    let performed = 0;
    const port: ActionPort = {
      async run(value) {
        const check = await verifyApprovedAction(value, { now: Date.now(), audience: CONFORMANCE_AUDIENCE, verifier: conformanceVerifier() });
        if (!check.ok) return check.outcome;
        const a = check.action;
        const op = served.get(a.action.id);
        if (!op) return refuse("connect/unknown-action", "Unknown.");
        // Its one connection is a production account.
        if (a.environment !== "production") return refuse("connect/environment-mismatch", "Another environment.");
        if (a.action.contract !== undefined && a.action.contract !== op.digest) return refuse("connect/contract-mismatch", "Changed.");
        if (a.action.effect === "read" && op.effect === "write") return refuse("connect/effect-mismatch", "A write.");
        if (a.purpose === "compensate") {
          if (a.undoes === undefined || served.get(a.undoes)?.compensate !== a.action.id) return refuse("connect/effect-mismatch", "Not its undo.");
          if (op.idempotent !== true) return refuse("connect/idempotency-mismatch", "Not safe to send again.");
          if ((op.riskFloor ?? "none") !== "none") return refuse("connect/approval-invalid", "Needs a review.");
        }
        performed++;
        return { status: "ok", output: { id: "n-1" } };
      },
    };
    return { port, performed: () => performed };
  }

  it("passes a port that follows the contract", async () => {
    const { port, performed } = referencePort();
    const cases = actionPortConformance(port, { read: { ...read, contract: served.get("notes.get")!.digest }, write, undos, performed, performedWrite: write });
    expect(cases.length).toBeGreaterThanOrEqual(10);
    expect(cases.map((c) => c.name)).toEqual(
      expect.arrayContaining(["refuses a declared undo that needs a review", "refuses a declared undo that does not de-duplicate", "refuses an undo sent for a write that does not declare it"]),
    );
    for (const c of cases) await c.run();
    // The well-formed read, the read with a malformed traceparent, and the read and write each sent again after a version refusal.
    expect(performed()).toBe(4);
  });

  it("fails a port that claims an attempt before it checks the envelope's version", async () => {
    // The engine sends the same attempt again after connect/contract-unsupported: a performer that
    // remembered the attempt first refuses its own resend as a replay.
    const claimed = new Set<string>();
    const { port: reference } = referencePort();
    const eager: ActionPort = {
      async run(value, signal) {
        const a = value as ApprovedAction;
        const key = `${a.effectId}#${a.attempt}`;
        if (a.action?.effect === "write" && claimed.has(key)) return refuse("connect/replayed", "Seen.");
        claimed.add(key);
        return reference.run(value, signal);
      },
    };
    const resend = actionPortConformance(eager, { read, performedWrite: write }).find((c) => c.name === "performs an attempt it refused for its contract version, sent again in one it serves")!;
    await expect(resend.run()).rejects.toThrow(/notes.create: the same attempt in contract 1: expected ok, got .*connect\/replayed/);
    // Without the write, the case cannot see the replay guard.
    await actionPortConformance(eager, { read }).find((c) => c.name === resend.name)!.run();
  });

  it("fails a port that performs whatever it is sent, or throws, or answers unknown", async () => {
    let performed = 0;
    const careless: ActionPort = { run: async () => (performed++, { status: "ok", output: null }) };
    const carelessCases = actionPortConformance(careless, { read, write, performed: () => performed });
    const failures = await Promise.all(carelessCases.map((c) => c.run().then(() => null, (error: Error) => error.message)));
    // Only the cases that perform a read pass; every refusal fails.
    expect(carelessCases.filter((_c, i) => failures[i] === null).map((c) => c.name)).toEqual(["performs a well-formed read", "performs a read whatever its traceparent"]);

    const throwing: ActionPort = {
      run: async () => {
        throw new Error("boom");
      },
    };
    await expect(actionPortConformance(throwing, { read })[1]!.run()).rejects.toThrow(/threw/);

    const unknown: ActionPort = { run: async (): Promise<ActionOutcome> => ({ status: "unknown", error: { code: "connect/expired", message: "?" } }) };
    await expect(actionPortConformance(unknown, { read })[4]!.run()).rejects.toThrow(/expected a refusal/);
  });
});

describe("isDeliverRequest", () => {
  it("accepts an event for a waiting run, and nothing malformed, without throwing", () => {
    expect(isDeliverRequest({ event: "payment.completed", correlation: { ref: "P-1" }, payload: null })).toBe(true);
    expect(isDeliverRequest({ event: "payment.completed", correlation: "P-1", payload: { a: 1 }, dedupeKey: "evt_1" })).toBe(true);
    const throwing = { get event(): string { throw new Error("boom"); }, correlation: "x", payload: {} };
    for (const bad of [
      null,
      [],
      throwing,
      new Proxy({}, { ownKeys: () => { throw new Error("boom"); } }),
      { event: "Payment", correlation: "x", payload: {} },
      { event: "payment.completed", payload: {} },
      { event: "payment.completed", correlation: "x" },
      { event: "payment.completed", correlation: "x", payload: {}, dedupeKey: "" },
      { event: "payment.completed", correlation: "x", payload: {}, dedupeKey: 7 },
      { event: "payment.completed", correlation: "x", payload: {}, extra: true },
      { event: "payment.completed", correlation: "x", payload: () => 1 },
    ]) expect(isDeliverRequest(bad)).toBe(false);
  });

  it("accepts the connection an event came from, and no malformed one", () => {
    const base = { event: "mail.replied", correlation: "thread-1", payload: {} };
    expect(isDeliverRequest({ ...base, connection: { id: "conn-1", subjectId: "member:ann" } })).toBe(true);
    expect(isDeliverRequest({ ...base, connection: { id: "conn-1", subjectId: null } })).toBe(true);
    for (const connection of [null, "conn-1", {}, { id: "conn-1" }, { id: "", subjectId: null }, { id: "conn-1", subjectId: "ann" }, { id: "conn-1", subjectId: ":ann" }, { id: "conn-1", subjectId: null, role: "mail" }, { id: "x".repeat(257), subjectId: null }]) {
      expect([connection, isDeliverRequest({ ...base, connection })]).toEqual([connection, false]);
      expect(isDeliverConnection(connection)).toBe(false);
    }
  });
});
