/**
 * The conformance suite every action port runs: the engine's test fakes, the
 * connector kit's port, and Aaply Connect. It checks the refusals of the
 * contract, not what an operation does: a well-formed call is performed, and
 * a malformed, expired, unknown, mismatched or unreviewed one, one for a
 * connection of another kind of environment, or an undo with an operation
 * that is not declared as one, that is not the undo its write declares, that
 * needs a review or that does not de-duplicate, is refused before anything
 * is sent, never thrown, and never answered `unknown`. An attempt refused for
 * its contract version is performed when the same attempt comes again in a
 * version the port serves: the refusal performed and claimed nothing.
 *
 * Framework-free: each case throws on failure, so any test runner can run them:
 *
 *   for (const c of actionPortConformance(port, { read, write, performed })) it(c.name, c.run);
 */

import { deepFreeze } from "./frozen.js";
import { ACTION_CONTRACT_VERSION, type ActionPort, type ApprovalEvidence, type ApprovedAction, type IdentityRef } from "./approved.js";
import { UNSIGNED_PROOF, approvalBinding, approvedActionSigningBytes, hmacActionSigner, hmacActionVerifier, signApprovedAction, type ApprovedActionSigner, type ApprovedActionVerifier } from "./signing.js";
import { sha256Digest, type Sha256Digest } from "./digest.js";
import { cloneJson, type JsonObject } from "./json.js";
import type { ActionOutcome } from "./outcome.js";
import { CONNECT_REFUSALS, isRefusalCode, type ConnectRefusalCode } from "./refusals.js";
import { ENVIRONMENT_KINDS } from "./environment.js";
import { ACTION_CONTRACT_VERSIONS, isActionPortDescription } from "./contract-versions.js";
import type { ActingFor, ActionEffectKind, ActionPurpose, ActorKind, EnvironmentKind, Risk, Scope } from "./scope.js";

/** What {@link draftApprovedAction} needs; everything else has a default. */
export interface ApprovedActionDraft {
  action: string;
  effect: ActionEffectKind;
  input: JsonObject;
  /** Epoch ms on the performer's clock: `issuedAt`, and the deadline is `now + timeoutMs`. */
  now: number;
  /** Default {@link CONFORMANCE_AUDIENCE}. */
  audience?: string;
  /** The HMAC key the draft is signed with; default {@link CONFORMANCE_KEY}. `null` leaves it unsigned (an `alg: "none"` proof). */
  key?: { keyId: string; secret: string } | null;
  /** `origin.runId`; default `run-conformance`. */
  runId?: string;
  /** Default true for a read and for a `compensate` (as the engine sends an undo), false otherwise. */
  idempotent?: boolean;
  risk?: Risk;
  contract?: Sha256Digest;
  purpose?: ActionPurpose;
  role?: string | null;
  actingFor?: ActingFor;
  scope?: Scope;
  /** Default `production`, the kind of a connection that declares none. */
  environment?: EnvironmentKind;
  subject?: IdentityRef | null;
  effectId?: string;
  attempt?: number;
  timeoutMs?: number;
  /** Review evidence; by default a valid one is added for a `run` of risk `confirm` or `approval`. */
  approval?: ApprovalEvidence | null;
  /** The completion token; default a fixed test value. `null` leaves it out. */
  completionToken?: string | null;
  /** The write a `compensate` or `reconcile` is about; default `<effectId>-target` for those purposes. `null` leaves it out. */
  target?: string | null;
  /** For a `compensate`: the action id of the write it undoes; default {@link CONFORMANCE_UNDONE}. `null` leaves it out. */
  undoes?: string | null;
  /** `origin.causedBy`; default the draft's actor, a member. */
  causedBy?: (IdentityRef & { kind: ActorKind }) | null;
  /** The W3C `traceparent`; none by default. Not checked: a test may give a malformed one on purpose. */
  traceparent?: string;
}

/** The write a draft `compensate` says it undoes unless told otherwise: an action no port serves. */
export const CONFORMANCE_UNDONE = "conformance-undone.write";

/** The scope conformance envelopes use unless told otherwise. */
export const CONFORMANCE_SCOPE: Scope = deepFreeze({ tenantId: "tenant-conformance", appId: "app-conformance", environmentId: "env-conformance" });

/** The audience conformance envelopes are for unless told otherwise. */
export const CONFORMANCE_AUDIENCE = "conformance-performer";

/** The HMAC key conformance envelopes are signed with unless told otherwise. A test key: never use it for real envelopes. */
export const CONFORMANCE_KEY: Readonly<{ keyId: string; secret: string }> = Object.freeze({ keyId: "conformance", secret: "conformance-envelope-key-not-secret-0123456789" });

/** A verifier that accepts {@link CONFORMANCE_KEY}: give it to a port under test. */
export function conformanceVerifier(): ApprovedActionVerifier {
  return hmacActionVerifier({ [CONFORMANCE_KEY.keyId]: CONFORMANCE_KEY.secret });
}

/**
 * Signs an envelope again with an HMAC key (default {@link CONFORMANCE_KEY}),
 * after a test changed a field on purpose. Synchronous; for tests only.
 */
export function sealApprovedAction(action: ApprovedAction | Omit<ApprovedAction, "proof">, key: { keyId: string; secret: string } = CONFORMANCE_KEY): ApprovedAction {
  return { ...action, proof: hmacActionSigner(key).sign(approvedActionSigningBytes(action)) } as ApprovedAction;
}

/** Review evidence for a draft's input, bound to its action and run (see `approvalBinding`). */
export function draftApproval(parts: { action: string; input: JsonObject; kind?: "confirm" | "approval"; runId?: string; name?: string; item?: string; by?: ApprovalEvidence["by"]; at?: number; notAfter?: number }): ApprovalEvidence {
  const inputDigest = sha256Digest(cloneJson(parts.input));
  return {
    kind: parts.kind ?? "confirm",
    by: parts.by ?? { domain: "staff", id: "conformance-reviewer", kind: "staff", roles: [] },
    inputDigest,
    rev: 1,
    ...(parts.at !== undefined ? { at: parts.at } : {}),
    ...(parts.notAfter !== undefined ? { notAfter: parts.notAfter } : {}),
    binding: approvalBinding({ action: parts.action, runId: parts.runId ?? "run-conformance", name: parts.name ?? "conformance", ...(parts.item !== undefined ? { item: parts.item } : {}), inputDigest }),
  };
}

/**
 * A complete, valid envelope for tests and conformance: the digests are
 * computed, a `run` of a reviewed action carries matching evidence from a
 * reviewer who is not the run's person, bound to the draft's action and run,
 * and it is signed with {@link CONFORMANCE_KEY} for {@link CONFORMANCE_AUDIENCE}
 * unless told otherwise.
 */
export function draftApprovedAction(draft: ApprovedActionDraft): ApprovedAction {
  const purpose = draft.purpose ?? "run";
  const risk = draft.risk ?? "none";
  const input = cloneJson(draft.input);
  const inputDigest = sha256Digest(input);
  const timeoutMs = draft.timeoutMs ?? 10_000;
  const effectId = draft.effectId ?? "effect-conformance";
  const target = draft.target === null ? undefined : (draft.target ?? (purpose === "run" ? undefined : `${effectId}-target`));
  const undoes = draft.undoes === null ? undefined : (draft.undoes ?? (purpose === "compensate" ? CONFORMANCE_UNDONE : undefined));
  const runId = draft.runId ?? "run-conformance";
  const approval =
    draft.approval === null
      ? undefined
      : (draft.approval ??
        (purpose === "run" && risk !== "none" ? draftApproval({ action: draft.action, input, kind: risk === "approval" ? "approval" : "confirm", runId, at: draft.now }) : undefined));
  const unsigned: Omit<ApprovedAction, "proof"> = {
    contract: ACTION_CONTRACT_VERSION,
    audience: draft.audience ?? CONFORMANCE_AUDIENCE,
    issuedAt: draft.now,
    scope: draft.scope ?? CONFORMANCE_SCOPE,
    environment: draft.environment ?? "production",
    effectId,
    attempt: draft.attempt ?? 1,
    purpose,
    ...(target !== undefined ? { target } : {}),
    ...(undoes !== undefined ? { undoes } : {}),
    idempotencyKey: `idem-conformance-${effectId}`,
    action: {
      id: draft.action,
      effect: draft.effect,
      idempotent: draft.idempotent ?? (draft.effect === "read" || purpose === "compensate"),
      risk,
      ...(draft.contract !== undefined ? { contract: draft.contract } : {}),
    },
    connection: { role: draft.role === undefined ? null : draft.role, actingFor: draft.actingFor ?? "business" },
    input,
    inputDigest,
    origin: {
      runId,
      flowId: "conformance",
      flowVersion: "1",
      flowHash: "conformance",
      stepId: "conformance",
      name: "conformance",
      revision: 1,
      causedBy: draft.causedBy === undefined ? { domain: "member", kind: "member", id: "conformance-actor" } : draft.causedBy,
    },
    actor: { domain: "member", kind: "member", id: "conformance-actor" },
    subject: draft.subject === undefined ? { domain: "member", id: "conformance-subject" } : draft.subject,
    ...(approval !== undefined ? { approval } : {}),
    deadline: draft.now + timeoutMs,
    timeoutMs,
    ...(draft.completionToken === null ? {} : { completion: { token: draft.completionToken ?? "completion-conformance" } }),
    ...(draft.traceparent !== undefined ? { traceparent: draft.traceparent } : {}),
  };
  return draft.key === null ? { ...unsigned, proof: { ...UNSIGNED_PROOF } } : sealApprovedAction(unsigned, draft.key ?? CONFORMANCE_KEY);
}

/** One conformance case. `run` throws on failure. */
export interface ActionPortConformanceCase {
  name: string;
  run(): Promise<void>;
}

/** A call the port under test serves. */
export interface ConformanceCall {
  action: string;
  input: JsonObject;
  role?: string | null;
  actingFor?: ActingFor;
  /** The digest the port serves for this action, when it serves pinned contracts. */
  contract?: Sha256Digest;
  /** For a write: its risk floor, so the suite sends it reviewed. Default `none`. */
  risk?: Risk;
  idempotent?: boolean;
  /**
   * For a write: it is declared as another operation's undo (`compensate`).
   * Default false, and the suite then checks that the port refuses to run it
   * as an undo.
   */
  undo?: boolean;
}

/**
 * A write the port serves that another operation declares as its undo. Its
 * `risk` is its risk floor and `idempotent` its idempotency (default true),
 * as the operation declares them, whatever an undo should be: the suite
 * checks that one needing a review, or not de-duplicating, is refused.
 */
export interface ConformanceUndo extends ConformanceCall {
  /** The action id of the write whose operation declares this undo. */
  undoes: string;
}

/** What `actionPortConformance` exercises: a read and a write the port serves, and how to watch what it performed. */
export interface ActionPortConformanceOptions {
  /** A read the port performs and answers `ok`. */
  read: ConformanceCall;
  /** A write the port serves. Used only for refusals: it is never meant to be performed. */
  write?: ConformanceCall;
  /**
   * A write the port performs and answers `ok`, best one whose operation does
   * not de-duplicate, so the port claims each attempt in its replay guard.
   * The case that sends an attempt again after refusing it for its contract
   * version sends it as well as the read; without it, only the read. When it
   * says `idempotent: false` (its operation does not de-duplicate), a case
   * also sends the same envelope twice and expects the second refused
   * (`connect/replayed`); left out, that case does not run.
   */
  performedWrite?: ConformanceCall;
  /**
   * Declared undos the port serves, each with one fault or none: one whose
   * risk floor is above `none`, one that does not de-duplicate, and one that
   * is a proper undo (used to send it for a write that does not declare it).
   * Used only for refusals. Each kind adds its case when given.
   */
  undos?: readonly ConformanceUndo[];
  /** How many calls reached the outside world so far. Must not move when the port refuses. */
  performed?: () => number;
  /** The port's clock. Default `Date.now`. */
  now?: () => number;
  scope?: Scope;
  /** The kind of environment the port's connections serve, which the read is sent in. Default `production`. */
  environment?: EnvironmentKind;
  /**
   * The kinds the suite sends the read in to check that a connection of
   * another kind is refused (`connect/environment-mismatch`, or
   * `connect/no-connection` from a resolver that finds none of that kind).
   * Default every kind but `environment`. An empty list fails the case.
   */
  foreignEnvironments?: readonly EnvironmentKind[];
  /** The port's audience. Default {@link CONFORMANCE_AUDIENCE}. */
  audience?: string;
  /** Signs the suite's envelopes with a key the port's verifier accepts. Default {@link CONFORMANCE_KEY} (give the port {@link conformanceVerifier}). */
  signer?: ApprovedActionSigner;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`action port conformance: ${message}`);
}

function describe(outcome: unknown): string {
  try {
    return JSON.stringify(outcome);
  } catch {
    return String(outcome);
  }
}

/** A key no port under test accepts. */
const STRANGER_KEY = { keyId: "conformance-stranger", secret: "a-key-the-port-under-test-never-accepts-0123456789" };

/**
 * The cases every action port must pass. Each sends one envelope (fresh
 * effect id per case) and checks the outcome, and that a refusal is the
 * tabled kind and sends nothing.
 */
export function actionPortConformance(port: ActionPort, options: ActionPortConformanceOptions): ActionPortConformanceCase[] {
  const now = options.now ?? (() => Date.now());
  const performed = options.performed ?? (() => 0);
  const audience = options.audience ?? CONFORMANCE_AUDIENCE;
  const signer = options.signer ?? hmacActionSigner(CONFORMANCE_KEY);
  let seq = 0;
  /** Signs a value as the engine would, whatever was changed in it. */
  const sign = (value: ApprovedAction | Omit<ApprovedAction, "proof">): Promise<ApprovedAction> => signApprovedAction<ApprovedAction>(value, signer);
  const envelope = (call: ConformanceCall, effect: ActionEffectKind, extra: Partial<ApprovedActionDraft> = {}): Promise<ApprovedAction> =>
    sign(
      draftApprovedAction({
        action: call.action,
        effect,
        input: call.input,
        now: now(),
        audience,
        effectId: `effect-conformance-${++seq}`,
        ...(call.role !== undefined ? { role: call.role } : {}),
        ...(call.actingFor !== undefined ? { actingFor: call.actingFor } : {}),
        ...(call.contract !== undefined ? { contract: call.contract } : {}),
        ...(call.risk !== undefined ? { risk: call.risk } : {}),
        ...(call.idempotent !== undefined ? { idempotent: call.idempotent } : {}),
        ...(options.scope !== undefined ? { scope: options.scope } : {}),
        ...(options.environment !== undefined ? { environment: options.environment } : {}),
        ...extra,
        key: null,
      }),
    );

  const send = async (value: unknown): Promise<ActionOutcome> => {
    const controller = new AbortController();
    let outcome: ActionOutcome;
    try {
      outcome = await port.run(value as ApprovedAction, controller.signal);
    } catch (error) {
      throw new Error(`action port conformance: run threw instead of answering an outcome (${String(error)})`);
    }
    return outcome;
  };

  const refused = async (name: string, value: unknown, codes: readonly ConnectRefusalCode[]): Promise<void> => {
    const before = performed();
    const outcome = await send(value);
    assert(outcome && (outcome.status === "final" || outcome.status === "retryable"), `${name}: expected a refusal, got ${describe(outcome)}`);
    const code = outcome.error.code;
    assert(isRefusalCode(code), `${name}: "${code}" is not a refusal code`);
    assert(codes.includes(code), `${name}: expected ${codes.join(" or ")}, got ${code}`);
    assert(CONNECT_REFUSALS[code] === outcome.status, `${name}: ${code} must be answered ${CONNECT_REFUSALS[code]}, not ${outcome.status}`);
    assert(performed() === before, `${name}: the port sent something before refusing`);
  };

  const cases: ActionPortConformanceCase[] = [
    {
      name: "performs a well-formed read",
      async run() {
        const outcome = await send(await envelope(options.read, "read"));
        assert(outcome.status === "ok", `expected ok, got ${describe(outcome)}`);
      },
    },
    {
      name: "refuses what is not an envelope, without throwing",
      async run() {
        for (const value of [null, undefined, "run", 7, [], {}, { contract: "1" }]) await refused(`value ${describe(value)}`, value, ["connect/invalid-envelope"]);
      },
    },
    {
      name: "refuses an envelope of an unsupported contract version",
      async run() {
        await refused("contract 2", { ...(await envelope(options.read, "read")), contract: 2 }, ["connect/contract-unsupported"]);
        await refused("contract 0", { ...(await envelope(options.read, "read")), contract: 0 }, ["connect/contract-unsupported"]);
      },
    },
    {
      name: "refuses a malformed envelope",
      async run() {
        const good = await envelope(options.read, "read");
        const { proof: _proof, ...unproved } = good;
        const broken: Array<[string, unknown]> = [
          ["attempt 0", { ...good, attempt: 0 }],
          ["no scope", { ...good, scope: undefined }],
          ["input not an object", { ...good, input: [1] }],
          ["unknown purpose", { ...good, purpose: "maybe" }],
          ["malformed input digest", { ...good, inputDigest: "sha256:nope" }],
          ["connection carrying an account", { ...good, connection: { role: 7, actingFor: "business" } }],
          ["no origin", { ...good, origin: null }],
          ["negative deadline", { ...good, deadline: -1 }],
          ["no audience", { ...good, audience: "" }],
          ["no proof", unproved],
        ];
        for (const [name, value] of broken) await refused(name, value, ["connect/invalid-envelope"]);
      },
    },
    {
      name: "refuses an envelope for another performer",
      async run() {
        await refused("other audience", await envelope(options.read, "read", { audience: `${audience}-other` }), ["connect/wrong-audience"]);
      },
    },
    {
      name: "refuses an envelope whose proof does not verify",
      async run() {
        const good = await envelope(options.read, "read");
        // Moved to another tenant after it was signed.
        await refused("re-scoped", { ...good, scope: { ...good.scope, tenantId: `${good.scope.tenantId}-other` } }, ["connect/proof-invalid"]);
        await refused("unsigned", { ...good, proof: { ...UNSIGNED_PROOF } }, ["connect/proof-invalid"]);
        await refused("signed by a stranger", sealApprovedAction(good, STRANGER_KEY), ["connect/proof-invalid"]);
      },
    },
    {
      name: "refuses an envelope whose times are not believable",
      async run() {
        const at = now() + 60 * 60_000;
        await refused("issued in the future", await sign({ ...(await envelope(options.read, "read")), issuedAt: at, deadline: at + 10_000 }), ["connect/clock-skew"]);
        const good = await envelope(options.read, "read");
        await refused("due beyond its timeout", await sign({ ...good, deadline: good.issuedAt + good.timeoutMs + 60 * 60_000 }), ["connect/invalid-envelope"]);
      },
    },
    {
      name: "refuses an envelope past its deadline, as retryable",
      async run() {
        const good = await envelope(options.read, "read", { now: now() - 20_000, timeoutMs: 10_000 });
        await refused("deadline passed", good, ["connect/late"]);
      },
    },
    {
      name: "refuses an envelope whose approval has expired",
      async run() {
        const approval = draftApproval({ action: options.read.action, input: options.read.input, notAfter: now() - 1 });
        await refused("notAfter passed", await envelope(options.read, "read", { approval }), ["connect/expired"]);
      },
    },
    {
      name: "refuses input that does not match its digest",
      async run() {
        const good = await envelope(options.read, "read");
        await refused("digest of other input", await sign({ ...good, inputDigest: sha256Digest({ other: true }) }), ["connect/invalid-input"]);
      },
    },
    {
      name: "refuses an undo or a check that names no target",
      async run() {
        await refused("reconcile without target", await envelope(options.read, "read", { purpose: "reconcile", target: null }), ["connect/invalid-envelope"]);
        if (options.write) {
          await refused("compensate without target", await envelope(options.write, "write", { purpose: "compensate", risk: "none", idempotent: true, approval: null, target: null }), ["connect/invalid-envelope"]);
          await refused("compensate naming no write it undoes", await envelope(options.write, "write", { purpose: "compensate", risk: "none", idempotent: true, approval: null, undoes: null }), ["connect/invalid-envelope"]);
        }
      },
    },
    {
      name: "refuses a reconcile that is not a read",
      async run() {
        await refused("reconcile as a write", await envelope(options.read, "write", { purpose: "reconcile" }), ["connect/effect-mismatch"]);
      },
    },
    {
      name: "refuses an action it does not serve",
      async run() {
        await refused("unknown action", await envelope({ ...options.read, action: "conformance-unknown.operation" }, "read"), ["connect/unknown-action"]);
      },
    },
    {
      name: "refuses a pinned operation contract it does not serve",
      async run() {
        await refused("other pin", await envelope({ ...options.read, contract: sha256Digest({ conformance: "not served" }) }, "read"), ["connect/contract-mismatch"]);
      },
    },
    {
      name: "refuses a connection that serves another kind of environment",
      async run() {
        const own = options.environment ?? "production";
        const foreign = options.foreignEnvironments ?? ENVIRONMENT_KINDS.filter((kind) => kind !== own);
        assert(foreign.length > 0, "foreignEnvironments must name at least one kind");
        assert(!foreign.includes(own), `foreignEnvironments must not include the port's own kind (${own})`);
        for (const kind of foreign) await refused(`a ${kind} call`, await envelope(options.read, "read", { environment: kind }), ["connect/environment-mismatch", "connect/no-connection"]);
      },
    },
    {
      name: "performs a read whatever its traceparent",
      async run() {
        // Correlation only: a malformed one (which an engine never sends) is ignored, never refused.
        const outcome = await send(await envelope(options.read, "read", { traceparent: "not-a-traceparent" }));
        assert(outcome.status === "ok", `a malformed traceparent: expected ok, got ${describe(outcome)}`);
      },
    },
    {
      name: "performs an attempt it refused for its contract version, sent again in one it serves",
      async run() {
        // The engine sends the same attempt again after connect/contract-unsupported (ADR-0009, amended):
        // the refusal must have performed nothing and claimed nothing, a replay guard included.
        const unsupported = Math.max(...ACTION_CONTRACT_VERSIONS) + 1;
        const calls: Array<[ConformanceCall, ActionEffectKind]> = [[options.read, "read"], ...(options.performedWrite ? [[options.performedWrite, "write"] as [ConformanceCall, ActionEffectKind]] : [])];
        for (const [call, effect] of calls) {
          const effectId = `effect-conformance-${++seq}`;
          await refused(`${call.action} in contract ${unsupported}`, { ...(await envelope(call, effect, { effectId })), contract: unsupported }, ["connect/contract-unsupported"]);
          const before = performed();
          const outcome = await send(await envelope(call, effect, { effectId }));
          assert(outcome.status === "ok", `${call.action}: the same attempt in contract ${ACTION_CONTRACT_VERSION}: expected ok, got ${describe(outcome)}`);
          assert(options.performed === undefined || performed() > before, `${call.action}: the same attempt in contract ${ACTION_CONTRACT_VERSION} answered ok without performing it`);
        }
      },
    },
  ];

  // A write that does not de-duplicate is performed once per attempt, however often its envelope arrives.
  const once = options.performedWrite;
  if (once && once.idempotent === false) {
    cases.push({
      name: "performs a write that does not de-duplicate once, when the same envelope arrives again",
      async run() {
        // A transport retry after a lost answer delivers the same signed attempt twice; sending it twice could charge or mail twice.
        const sealed = await envelope(once, "write");
        const first = await send(sealed);
        assert(first.status === "ok", `${once.action}: expected ok, got ${describe(first)}`);
        await refused(`${once.action} delivered again`, sealed, ["connect/replayed"]);
      },
    });
  }

  // A port that describes itself must describe what it does.
  if (typeof port.describe === "function") {
    cases.push({
      name: "describes the contract versions it serves, and refuses one it does not",
      async run() {
        let description: unknown;
        try {
          description = await port.describe!();
        } catch (error) {
          throw new Error(`action port conformance: describe threw (${String(error)})`);
        }
        assert(isActionPortDescription(description), `describe answered ${describe(description)}, not { contracts: [distinct positive integers] }`);
        assert(description.contracts.includes(ACTION_CONTRACT_VERSION), `describe does not list contract ${ACTION_CONTRACT_VERSION}, which the port performs`);
        const beyond = Math.max(...description.contracts) + 1;
        await refused(`contract ${beyond}`, { ...(await envelope(options.read, "read")), contract: beyond }, ["connect/contract-unsupported"]);
      },
    });
  }

  const write = options.write;
  if (write) {
    const risk = write.risk && write.risk !== "none" ? write.risk : "confirm";
    cases.push(
      {
        name: "refuses a write sent as a read",
        async run() {
          await refused("write as read", await envelope(write, "read"), ["connect/effect-mismatch"]);
        },
      },
      {
        name: "refuses a write whose review covers other input",
        async run() {
          const good = await envelope({ ...write, risk }, "write");
          const approval: ApprovalEvidence = { ...good.approval!, inputDigest: sha256Digest({ other: true }) };
          await refused("review of other input", await sign({ ...good, approval }), ["connect/approval-invalid"]);
          const { approval: _dropped, ...unreviewed } = good;
          await refused("no review", await sign(unreviewed), ["connect/approval-invalid"]);
        },
      },
      {
        name: "refuses a review given for another action or run",
        async run() {
          // The engine signs what it is given: the evidence itself must say what it covers.
          const good = await envelope({ ...write, risk }, "write");
          await refused("evidence of another run", await sign({ ...good, origin: { ...good.origin, runId: `${good.origin.runId}-other` } }), ["connect/approval-invalid"]);
          const other = draftApproval({ action: `${write.action}-other`, input: write.input, kind: good.approval!.kind });
          await refused("evidence of another action", await sign({ ...good, approval: other }), ["connect/approval-invalid"]);
        },
      },
    );
    if (write.undo !== true) {
      cases.push({
        name: "refuses to undo with a write that is not a declared undo",
        async run() {
          // Sent as the engine sends an undo: unreviewed, and maybe more than once.
          await refused("not an undo", await envelope(write, "write", { purpose: "compensate", risk: "none", idempotent: true, approval: null }), ["connect/effect-mismatch"]);
        },
      });
    }
  }

  // An undo is sent unreviewed, and again after an unknown answer. The engine
  // states the undo operation's own risk floor and idempotency when it knows
  // its contract, and `none` and `true` when it does not: both are refused.
  const undos = options.undos ?? [];
  const asUndo = (undo: ConformanceUndo, extra: Partial<ApprovedActionDraft>) => envelope(undo, "write", { purpose: "compensate", approval: null, undoes: undo.undoes, ...extra });
  const reviewed = undos.filter((u) => u.risk !== undefined && u.risk !== "none" && u.idempotent !== false);
  const repeated = undos.filter((u) => (u.risk ?? "none") === "none" && u.idempotent === false);
  const proper = undos.find((u) => (u.risk ?? "none") === "none" && u.idempotent !== false);
  if (reviewed.length > 0) {
    cases.push({
      name: "refuses a declared undo that needs a review",
      async run() {
        for (const undo of reviewed) {
          await refused(`${undo.action} with its own risk`, await asUndo(undo, { risk: undo.risk!, idempotent: true }), ["connect/approval-invalid"]);
          await refused(`${undo.action} sent unreviewed`, await asUndo(undo, { risk: "none", idempotent: true }), ["connect/approval-invalid"]);
        }
      },
    });
  }
  if (repeated.length > 0) {
    cases.push({
      name: "refuses a declared undo that does not de-duplicate",
      async run() {
        for (const undo of repeated) {
          await refused(`${undo.action} with its own idempotency`, await asUndo(undo, { risk: "none", idempotent: false }), ["connect/idempotency-mismatch"]);
          await refused(`${undo.action} marked safe to send again`, await asUndo(undo, { risk: "none", idempotent: true }), ["connect/idempotency-mismatch"]);
        }
      },
    });
  }
  if (proper) {
    cases.push({
      name: "refuses an undo sent for a write that does not declare it",
      async run() {
        // A read declares no undo.
        await refused(`${proper.action} undoing a read`, await asUndo({ ...proper, undoes: options.read.action }, { risk: "none", idempotent: true }), ["connect/effect-mismatch"]);
      },
    });
  }
  return cases;
}
