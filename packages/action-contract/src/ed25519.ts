/**
 * Ed25519 proofs for approved actions, through Web Crypto (Node 22.13 and
 * later, Deno, Bun, Cloudflare Workers): the pair for an engine and a
 * performer in different trust domains. The engine holds the private key and
 * signs; the performer holds only public keys, so it can check an approval
 * but never make one. The signed bytes are the same as for every proof
 * ({@link approvedActionSigningBytes}).
 *
 * A verifier takes its keys by key id, each with an optional `notAfter`, so
 * a key rotates by adding the new one, switching the engine to it, and
 * retiring the old one once the longest deadline signed under it has passed.
 * A key id names one Ed25519 key: a proof under that id with any other
 * algorithm is refused.
 */

import { fromBase64Url, toBase64Url } from "./hash.js";
import type { ActionProof, ApprovedActionSigner, ApprovedActionVerifier } from "./signing.js";

/** The algorithm name of an Ed25519 proof (RFC 9864's fully specified name). */
export const ED25519_PROOF_ALG = "Ed25519";

/** The parts of Web Crypto this module uses, typed here so the contract needs no DOM or Node types. */
interface Subtle {
  importKey(format: string, key: Uint8Array | object, algorithm: { name: string }, extractable: boolean, usages: string[]): Promise<unknown>;
  exportKey(format: string, key: unknown): Promise<ArrayBuffer>;
  generateKey(algorithm: { name: string }, extractable: boolean, usages: string[]): Promise<{ privateKey: unknown; publicKey: unknown }>;
  sign(algorithm: { name: string }, key: unknown, data: Uint8Array): Promise<ArrayBuffer>;
  verify(algorithm: { name: string }, key: unknown, signature: Uint8Array, data: Uint8Array): Promise<boolean>;
}

function subtle(): Subtle {
  const s = (globalThis as { crypto?: { subtle?: Subtle } }).crypto?.subtle;
  if (!s) throw new Error("Web Crypto is not available in this runtime");
  return s;
}

const ALG = { name: "Ed25519" };

/** An Ed25519 key pair as unpadded base64url text: the private key as PKCS #8, the public key as its 32 raw bytes. */
export interface Ed25519KeyPair {
  privateKey: string;
  publicKey: string;
}

/** Makes a new Ed25519 key pair, for tests and for setting up a deployment's keys. */
export async function generateEd25519KeyPair(): Promise<Ed25519KeyPair> {
  const pair = await subtle().generateKey(ALG, true, ["sign", "verify"]);
  return {
    privateKey: toBase64Url(new Uint8Array(await subtle().exportKey("pkcs8", pair.privateKey))),
    publicKey: toBase64Url(new Uint8Array(await subtle().exportKey("raw", pair.publicKey))),
  };
}

function checkKeyId(keyId: string): void {
  if (typeof keyId !== "string" || keyId.length === 0 || keyId.length > 256) throw new Error("keyId must be 1-256 characters");
}

/**
 * The engine's signer: Ed25519 under `privateKey` (PKCS #8, as bytes or
 * unpadded base64url), named by `keyId`. Load the key from the host's secret
 * store at start; it signs locally, with no call out per envelope.
 */
export function ed25519ActionSigner(key: { keyId: string; privateKey: string | Uint8Array }): ApprovedActionSigner {
  checkKeyId(key.keyId);
  const bytes = typeof key.privateKey === "string" ? fromBase64Url(key.privateKey) : key.privateKey;
  const imported = subtle().importKey("pkcs8", bytes, ALG, false, ["sign"]);
  // A key that cannot be imported fails the first signing, not the host's start: keep the rejection handled until then.
  imported.catch(() => undefined);
  return {
    async sign(data): Promise<ActionProof> {
      const sig = new Uint8Array(await subtle().sign(ALG, await imported, data));
      return { alg: ED25519_PROOF_ALG, keyId: key.keyId, sig: toBase64Url(sig) };
    },
  };
}

/** A public key a verifier accepts: the 32 raw bytes (or unpadded base64url), and optionally until when (epoch ms). */
export type Ed25519PublicKey = string | Uint8Array | { key: string | Uint8Array; notAfter?: number };

const P = (1n << 255n) - 19n;
/** The y coordinates of the eight points of small order (with either sign of x): a signature under one can be forged for any message. */
const SMALL_ORDER_Y = new Set([0n, 1n, P - 1n, leY("c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a"), leY("26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05")]);

function leY(hex: string): bigint {
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16) & (i === 31 ? 0x7f : 0xff));
  return y;
}

/** A public key no honest key pair has: a point of small order, or a non-canonical encoding (y not below p). */
function weakPublicKey(raw: Uint8Array): boolean {
  let hex = "";
  for (const b of raw) hex += b.toString(16).padStart(2, "0");
  const y = leY(hex);
  return y >= P || SMALL_ORDER_Y.has(y);
}

/**
 * The performer's verifier: accepts an Ed25519 proof under any of `keys`
 * (by key id) that has not passed its `notAfter` on `now` (default
 * `Date.now`). Anything else answers false: another algorithm, an unknown
 * key id, a malformed signature. A key of small order or in a non-canonical
 * encoding, under which anyone could forge a proof, is refused when the
 * verifier is made.
 */
export function ed25519ActionVerifier(keys: Readonly<Record<string, Ed25519PublicKey>>, options: { now?: () => number } = {}): ApprovedActionVerifier {
  const now = options.now ?? Date.now;
  const table = new Map<string, { key: Promise<unknown>; notAfter: number }>();
  for (const [keyId, entry] of Object.entries(keys)) {
    checkKeyId(keyId);
    const spec = entry instanceof Uint8Array || typeof entry === "string" ? { key: entry } : entry;
    if (typeof spec !== "object" || spec === null || !(typeof spec.key === "string" || spec.key instanceof Uint8Array)) {
      throw new Error(`the Ed25519 public key ${keyId} must be a string, a Uint8Array or { key, notAfter? }`);
    }
    const raw = typeof spec.key === "string" ? fromBase64Url(spec.key) : spec.key;
    if (raw.length !== 32) throw new Error(`the Ed25519 public key ${keyId} must be 32 bytes`);
    if (weakPublicKey(raw)) throw new Error(`the Ed25519 public key ${keyId} is not a valid key (a small-order or non-canonical point)`);
    if (spec.notAfter !== undefined && (typeof spec.notAfter !== "number" || !Number.isFinite(spec.notAfter))) throw new Error(`notAfter of ${keyId} must be a finite number, or left out`);
    const key = subtle().importKey("raw", raw, ALG, false, ["verify"]);
    key.catch(() => undefined);
    table.set(keyId, { key, notAfter: spec.notAfter ?? Number.POSITIVE_INFINITY });
  }
  return {
    async verify(data, proof) {
      if (proof.alg !== ED25519_PROOF_ALG || !Object.prototype.hasOwnProperty.call(keys, proof.keyId)) return false;
      const entry = table.get(proof.keyId);
      if (!entry || now() > entry.notAfter) return false;
      let sig: Uint8Array;
      try {
        sig = fromBase64Url(proof.sig);
      } catch {
        return false;
      }
      if (sig.length !== 64) return false;
      let key: unknown;
      try {
        key = await entry.key;
      } catch {
        // A runtime that checks points on import refused this key: nothing verifies under it.
        return false;
      }
      return subtle().verify(ALG, key, sig, data);
    },
  };
}
