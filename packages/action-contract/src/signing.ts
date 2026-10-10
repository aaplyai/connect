/**
 * Authenticating approved actions: the bytes a proof signs, the ports that
 * sign and verify them, a reference HMAC pair, and the approval binding.
 *
 * The contract defines only what is signed. Who holds which key, and with
 * which algorithm, is the host's: the engine is given an
 * {@link ApprovedActionSigner}, the performer an {@link ApprovedActionVerifier}.
 * The reference {@link hmacActionSigner} and {@link hmacActionVerifier} share
 * one secret, so they suit an engine and performer in one trust domain;
 * across trust domains, implement the same ports with an asymmetric key
 * (Ed25519 through Web Crypto, or a KMS), so the performer can verify but
 * never sign. The key signs envelopes only: it is the engine's own, never a
 * third party's credential.
 */

import { canonicalJson, type JsonValue } from "./json.js";
import { sha256Digest, type Sha256Digest } from "./digest.js";
import { hmacSha256, safeEqual, toBase64Url } from "./hash.js";
import type { Scope } from "./scope.js";

/** A signature over an approved action's {@link approvedActionSigningBytes}. */
export interface ActionProof {
  /** The algorithm, such as `HS256` or `EdDSA`. `none` marks an unsigned envelope, which every verifier refuses. */
  alg: string;
  /** Which key signed it, so keys can rotate. */
  keyId: string;
  /** The signature, unpadded base64url. */
  sig: string;
}

/** What a signer or verifier is told besides the bytes: the performer the action is for, and its tenant. */
export interface ActionKeyContext {
  audience: string;
  scope: Scope;
}

/** Signs approved actions. Supplied by the engine's host; may be async (a KMS). */
export interface ApprovedActionSigner {
  sign(bytes: Uint8Array, context: ActionKeyContext): ActionProof | Promise<ActionProof>;
}

/** Verifies an approved action's proof. Supplied by the performer's host. False, or a throw, refuses the action. */
export interface ApprovedActionVerifier {
  verify(bytes: Uint8Array, proof: ActionProof, context: ActionKeyContext): boolean | Promise<boolean>;
}

/** Prefixed to what a proof signs, so its bytes never mean anything else. */
export const APPROVED_ACTION_SIGNING_TAG = "aaply.approved-action.1\n";

/** The algorithm name of the reference HMAC-SHA-256 pair. */
export const HMAC_PROOF_ALG = "HS256";

/** The proof of an unsigned envelope (an engine given no signer). Every verifier refuses it. */
export const UNSIGNED_PROOF: Readonly<ActionProof> = Object.freeze({ alg: "none", keyId: "none", sig: "none" });

const encoder = new TextEncoder();

/**
 * The bytes a proof signs: {@link APPROVED_ACTION_SIGNING_TAG}, then the
 * canonical JSON of the envelope without its `proof`. Every other field is
 * covered (the audience, issue time, scope, subject, effect and attempt,
 * `origin.causedBy`, the input and the review), including fields a later
 * contract adds, so nothing can be changed or moved without the key.
 */
export function approvedActionSigningBytes(action: object): Uint8Array {
  const { proof: _proof, ...unsigned } = action as Record<string, unknown>;
  return encoder.encode(APPROVED_ACTION_SIGNING_TAG + canonicalJson(unsigned as JsonValue));
}

/** An approved action before it is signed. */
export type UnsignedApprovedAction<T extends { proof: ActionProof }> = Omit<T, "proof">;

/** True for a proof of the right shape. */
export function isActionProof(value: unknown): value is ActionProof {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const p = value as Record<string, unknown>;
  const str = (v: unknown, max: number) => typeof v === "string" && v.length > 0 && v.length <= max;
  return str(p.alg, 32) && str(p.keyId, 256) && str(p.sig, 4096);
}

function keyBytes(secret: string | Uint8Array): Uint8Array {
  const material = typeof secret === "string" ? encoder.encode(secret) : secret;
  if (material.length < 32) throw new Error("an envelope signing secret must be at least 32 bytes");
  return material;
}

/** The reference signer: HMAC-SHA-256 under one secret (at least 32 bytes), named by `keyId`. Synchronous. */
export function hmacActionSigner(key: { keyId: string; secret: string | Uint8Array }): ApprovedActionSigner & { sign(bytes: Uint8Array): ActionProof } {
  const material = keyBytes(key.secret);
  if (typeof key.keyId !== "string" || key.keyId.length === 0 || key.keyId.length > 256) throw new Error("keyId must be 1-256 characters");
  return { sign: (bytes) => ({ alg: HMAC_PROOF_ALG, keyId: key.keyId, sig: toBase64Url(hmacSha256(material, bytes)) }) };
}

/** The reference verifier: accepts an HS256 proof under any of `keys` (by key id), so keys can rotate. */
export function hmacActionVerifier(keys: Readonly<Record<string, string | Uint8Array>>): ApprovedActionVerifier {
  const table = new Map<string, Uint8Array>();
  for (const [keyId, secret] of Object.entries(keys)) table.set(keyId, keyBytes(secret));
  return {
    verify(bytes, proof) {
      const material = proof.alg === HMAC_PROOF_ALG && Object.prototype.hasOwnProperty.call(keys, proof.keyId) ? table.get(proof.keyId) : undefined;
      return material !== undefined && safeEqual(toBase64Url(hmacSha256(material, bytes)), proof.sig);
    },
  };
}

/** Signs an envelope: the same envelope with its `proof`. Throws when the signer fails or answers a malformed proof. */
export async function signApprovedAction<T extends { proof: ActionProof; audience: string; scope: Scope }>(unsigned: UnsignedApprovedAction<T>, signer: ApprovedActionSigner): Promise<T> {
  const proof = await signer.sign(approvedActionSigningBytes(unsigned), { audience: unsigned.audience, scope: unsigned.scope });
  if (!isActionProof(proof)) throw new Error("the envelope signer answered a malformed proof");
  return { ...unsigned, proof: { alg: proof.alg, keyId: proof.keyId, sig: proof.sig } } as unknown as T;
}

/** What an approval is bound to: the action, the run, the flow's name for it, the item and the input. */
export interface ApprovalBindingParts {
  /** The action id. */
  action: string;
  runId: string;
  /** The flow's name for the action (`origin.name`). */
  name: string;
  /** `origin.item`, for a per-item action. */
  item?: string;
  inputDigest: Sha256Digest;
}

/**
 * `approval.binding`: the digest of what the review covered. The engine
 * computes it when it records the evidence for a call, and every performer
 * recomputes it from the envelope, so evidence given for one action, run,
 * item or input never covers another, even when the input is equal.
 */
export function approvalBinding(parts: ApprovalBindingParts): Sha256Digest {
  return sha256Digest({ approval: 1, action: parts.action, runId: parts.runId, name: parts.name, item: parts.item ?? null, input: parts.inputDigest });
}
