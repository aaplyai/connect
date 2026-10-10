/**
 * The conformance cases every action port passes for blob references, beside
 * `actionPortConformance`. A port checks every reference in an envelope's
 * input against the envelope's scope before anything is sent: one made for
 * another tenant, app or environment, one changed since it was made, and one
 * that is not a well-formed reference are refused `connect/invalid-input`
 * (final), and nothing reaches the outside world.
 *
 *   for (const c of blobPortConformance(port, { call, performed })) it(c.name, c.run);
 */

import type { ActionPort, ApprovedAction } from "./approved.js";
import { blobDigestSync, makeBlobRef, type BlobRef } from "./blob.js";
import { CONFORMANCE_AUDIENCE, CONFORMANCE_KEY, CONFORMANCE_SCOPE, draftApprovedAction, type ActionPortConformanceCase } from "./conformance.js";
import type { Sha256Digest } from "./digest.js";
import type { JsonObject } from "./json.js";
import type { ActionOutcome } from "./outcome.js";
import { CONNECT_REFUSALS } from "./refusals.js";
import { hmacActionSigner, signApprovedAction, type ApprovedActionSigner } from "./signing.js";
import type { ActingFor, ActionEffectKind, EnvironmentKind, Risk, Scope } from "./scope.js";

/** A call the port serves whose input takes a blob reference. */
export interface BlobConformanceCall {
  action: string;
  effect: ActionEffectKind;
  /** The call's input, with `ref` where the operation takes a reference. */
  input(ref: BlobRef): JsonObject;
  role?: string | null;
  actingFor?: ActingFor;
  /** The digest the port serves for this action, when it serves pinned contracts. */
  contract?: Sha256Digest;
  /** For a write: its risk floor, so the suite sends it reviewed. Default `none`. */
  risk?: Risk;
  idempotent?: boolean;
}

/** What {@link blobPortConformance} exercises. */
export interface BlobPortConformanceOptions {
  call: BlobConformanceCall;
  /** How many calls reached the outside world so far. Must not move when the port refuses. */
  performed?: () => number;
  /** The port's clock. Default `Date.now`. */
  now?: () => number;
  /** The scope the suite's envelopes are for. Default the contract's conformance scope. */
  scope?: Scope;
  environment?: EnvironmentKind;
  /** The port's audience. Default the contract's conformance audience. */
  audience?: string;
  /** Signs the suite's envelopes with a key the port's verifier accepts. Default the conformance key. */
  signer?: ApprovedActionSigner;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`blob port conformance: ${message}`);
}

const BYTES = new TextEncoder().encode("blob port conformance");

/**
 * The cases every action port passes for blob references. Each sends one
 * envelope (a fresh effect id per case) and checks that it was refused
 * `connect/invalid-input` (final) and that nothing was performed.
 */
export function blobPortConformance(port: ActionPort, options: BlobPortConformanceOptions): ActionPortConformanceCase[] {
  const now = options.now ?? (() => Date.now());
  const performed = options.performed ?? (() => 0);
  const scope = options.scope ?? CONFORMANCE_SCOPE;
  const signer = options.signer ?? hmacActionSigner(CONFORMANCE_KEY);
  const call = options.call;
  let seq = 0;
  const parts = { id: "blob-conformance-1", digest: blobDigestSync(BYTES), size: BYTES.length, mediaType: "text/plain", name: "conformance.txt" };
  const other: Scope = { ...scope, tenantId: `${scope.tenantId}-other` };

  const envelope = (ref: unknown): Promise<ApprovedAction> =>
    signApprovedAction<ApprovedAction>(
      draftApprovedAction({
        action: call.action,
        effect: call.effect,
        input: call.input(ref as BlobRef),
        now: now(),
        audience: options.audience ?? CONFORMANCE_AUDIENCE,
        effectId: `effect-blob-conformance-${++seq}`,
        scope,
        ...(options.environment !== undefined ? { environment: options.environment } : {}),
        ...(call.role !== undefined ? { role: call.role } : {}),
        ...(call.actingFor !== undefined ? { actingFor: call.actingFor } : {}),
        ...(call.contract !== undefined ? { contract: call.contract } : {}),
        ...(call.risk !== undefined ? { risk: call.risk } : {}),
        ...(call.idempotent !== undefined ? { idempotent: call.idempotent } : {}),
        key: null,
      }),
      signer,
    );

  const refused = async (name: string, ref: unknown): Promise<void> => {
    const before = performed();
    let outcome: ActionOutcome;
    try {
      outcome = await port.run(await envelope(ref), new AbortController().signal);
    } catch (error) {
      throw new Error(`blob port conformance: ${name}: run threw instead of answering an outcome (${String(error)})`);
    }
    assert(outcome.status === "final", `${name}: expected a final refusal, got ${JSON.stringify(outcome)}`);
    assert(outcome.error.code === "connect/invalid-input", `${name}: expected connect/invalid-input, got ${outcome.error.code}`);
    assert(CONNECT_REFUSALS["connect/invalid-input"] === "final", `${name}: connect/invalid-input is tabled as final`);
    assert(performed() === before, `${name}: the port sent something before refusing`);
  };

  return [
    {
      name: "refuses a blob reference made for another scope, before sending anything",
      run: () => refused("another tenant's reference", makeBlobRef(other, parts)),
    },
    {
      name: "refuses a blob reference changed since it was made",
      run: async () => {
        const ref = makeBlobRef(scope, parts);
        await refused("a changed media type", { ...ref, mediaType: "application/pdf" });
        await refused("a changed size", { ...ref, size: ref.size + 1 });
      },
    },
    {
      name: "refuses a malformed blob reference",
      run: async () => {
        const ref = makeBlobRef(scope, parts);
        await refused("an extra field", { ...ref, url: "https://files.example.com/x" });
        await refused("no binding", { ...ref, binding: undefined });
        await refused("another format version", { ...ref, $blob: 2 });
      },
    },
  ];
}
