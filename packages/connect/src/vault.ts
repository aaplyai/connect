/**
 * The vault: every connection's secret is sealed with AES-256-GCM under its
 * tenant's data key, with a fresh IV each time. The additional data binds
 * the ciphertext to its tenant, connection and secret version, so a sealed
 * secret copied to another row does not open. Data keys are wrapped by a
 * {@link KeyProvider} (a local key for development, a KMS later) and kept
 * unwrapped in memory for at most five minutes.
 *
 * Revoking a connection deletes its sealed secret. Rows deleted in
 * PostgreSQL can live on in backups until they age out: that is not
 * crypto-shredding, and the docs say so.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** Wraps and unwraps tenants' data keys. */
export interface KeyProvider {
  /** The id of the key new data keys are wrapped under. */
  readonly keyId: string;
  wrap(dataKey: Uint8Array, context: { tenantId: string; dataKeyId: string }): Promise<Uint8Array>;
  unwrap(wrapped: Uint8Array, context: { tenantId: string; dataKeyId: string; keyId: string }): Promise<Uint8Array>;
}

/** A sealed secret as the store keeps it. */
export interface SealedSecret {
  /** The data key it is sealed under. */
  dataKeyId: string;
  /** The secret version it is sealed for (bound in the additional data). Moves only when the secret changes. */
  version: number;
  iv: Uint8Array;
  /** Ciphertext followed by the 16-byte GCM tag. */
  sealed: Uint8Array;
}

const TAG = 16;

function aad(tenantId: string, connectionId: string, version: number): Buffer {
  return Buffer.from(`aaply.connect.secret.1\n${tenantId}\n${connectionId}\n${version}`, "utf8");
}

function aesSeal(key: Uint8Array, plaintext: Uint8Array, additional: Uint8Array): { iv: Uint8Array; sealed: Uint8Array } {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(additional);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return { iv, sealed: body };
}

function aesOpen(key: Uint8Array, iv: Uint8Array, sealed: Uint8Array, additional: Uint8Array): Buffer {
  if (sealed.length < TAG) throw new Error("sealed value too short");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(additional);
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG));
  return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - TAG)), decipher.final()]);
}

/**
 * A {@link KeyProvider} holding one 32-byte key in memory, read from the
 * deployment's secret store at start. For development and single-region
 * deployments; a KMS-backed provider replaces it without a data change.
 */
export function localKeyProvider(options: { keyId: string; key: Uint8Array }): KeyProvider {
  if (options.key.length !== 32) throw new Error("the local wrapping key must be 32 bytes");
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(options.keyId)) throw new Error("keyId must be 1-64 letters, digits, '.', '_' or '-'");
  const key = Uint8Array.from(options.key);
  const context = (tenantId: string, dataKeyId: string, keyId: string) => Buffer.from(`aaply.connect.data-key.1\n${keyId}\n${tenantId}\n${dataKeyId}`, "utf8");
  return {
    keyId: options.keyId,
    async wrap(dataKey, { tenantId, dataKeyId }) {
      const { iv, sealed } = aesSeal(key, dataKey, context(tenantId, dataKeyId, options.keyId));
      const out = new Uint8Array(12 + sealed.length);
      out.set(iv, 0);
      out.set(sealed, 12);
      return out;
    },
    async unwrap(wrapped, { tenantId, dataKeyId, keyId }) {
      if (keyId !== options.keyId) throw new Error(`no wrapping key ${keyId}`);
      return new Uint8Array(aesOpen(key, wrapped.subarray(0, 12), wrapped.subarray(12), context(tenantId, dataKeyId, keyId)));
    },
  };
}

/** Where the vault finds a tenant's data keys. Implemented by the store. */
export interface DataKeyStore {
  /** The tenant's current data key, wrapped, creating it with `create` when there is none. */
  currentDataKey(tenantId: string, create: () => Promise<{ dataKeyId: string; wrapped: Uint8Array; wrappingKeyId: string }>): Promise<{ dataKeyId: string; wrapped: Uint8Array; wrappingKeyId: string }>;
}

/** A wrapped data key, as the hot path reads it alongside the sealed secret. */
export interface WrappedDataKey {
  dataKeyId: string;
  wrapped: Uint8Array;
  wrappingKeyId: string;
}

export interface Vault {
  seal(tenantId: string, connectionId: string, version: number, secret: Readonly<Record<string, string>>): Promise<SealedSecret>;
  open(tenantId: string, connectionId: string, secret: SealedSecret, dataKey: WrappedDataKey): Promise<Record<string, string>>;
}

const CACHE_MS = 5 * 60_000;
const CACHE_MAX = 10_000;

export function createVault(options: { keys: KeyProvider; store: DataKeyStore; now?: () => number }): Vault {
  const now = options.now ?? Date.now;
  // Least recently used first; one pending unwrap per key, so concurrent first calls unwrap once.
  const cache = new Map<string, { key: Promise<Uint8Array>; until: number }>();
  const unwrap = (tenantId: string, dataKey: WrappedDataKey): Promise<Uint8Array> => {
    const id = `${tenantId}\n${dataKey.dataKeyId}`;
    const hit = cache.get(id);
    if (hit && hit.until > now()) {
      cache.delete(id);
      cache.set(id, hit);
      return hit.key;
    }
    const key = options.keys.unwrap(dataKey.wrapped, { tenantId, dataKeyId: dataKey.dataKeyId, keyId: dataKey.wrappingKeyId }).then((k) => {
      if (k.length !== 32) throw new Error("a data key must be 32 bytes");
      return k;
    });
    cache.delete(id);
    cache.set(id, { key, until: now() + CACHE_MS });
    // A failed unwrap is not kept: the next call tries again.
    key.catch(() => cache.get(id)?.key === key && cache.delete(id));
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
    return key;
  };
  return {
    async seal(tenantId, connectionId, version, secret) {
      const current = await options.store.currentDataKey(tenantId, async () => {
        const dataKeyId = `dk_${randomBytes(8).toString("hex")}`;
        return { dataKeyId, wrapped: await options.keys.wrap(randomBytes(32), { tenantId, dataKeyId }), wrappingKeyId: options.keys.keyId };
      });
      const key = await unwrap(tenantId, current);
      const { iv, sealed } = aesSeal(key, Buffer.from(JSON.stringify(secret), "utf8"), aad(tenantId, connectionId, version));
      return { dataKeyId: current.dataKeyId, version, iv, sealed };
    },
    async open(tenantId, connectionId, secret, dataKey) {
      if (secret.dataKeyId !== dataKey.dataKeyId) throw new Error("the secret is sealed under another data key");
      const key = await unwrap(tenantId, dataKey);
      const plain = aesOpen(key, secret.iv, secret.sealed, aad(tenantId, connectionId, secret.version));
      const parsed: unknown = JSON.parse(plain.toString("utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || !Object.values(parsed).every((v) => typeof v === "string")) throw new Error("a sealed secret is not a map of strings");
      return parsed as Record<string, string>;
    },
  };
}
