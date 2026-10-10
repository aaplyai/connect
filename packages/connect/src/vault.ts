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
  wrap(dataKey: Uint8Array, context: { tenantId: string }): Promise<Uint8Array>;
  unwrap(wrapped: Uint8Array, context: { tenantId: string; keyId: string }): Promise<Uint8Array>;
}

/** A sealed secret as the store keeps it. */
export interface SealedSecret {
  /** The data key it is sealed under. */
  dataKeyId: string;
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
  const context = (tenantId: string, keyId: string) => Buffer.from(`aaply.connect.data-key.1\n${keyId}\n${tenantId}`, "utf8");
  return {
    keyId: options.keyId,
    async wrap(dataKey, { tenantId }) {
      const { iv, sealed } = aesSeal(key, dataKey, context(tenantId, options.keyId));
      const out = new Uint8Array(12 + sealed.length);
      out.set(iv, 0);
      out.set(sealed, 12);
      return out;
    },
    async unwrap(wrapped, { tenantId, keyId }) {
      if (keyId !== options.keyId) throw new Error(`no wrapping key ${keyId}`);
      return new Uint8Array(aesOpen(key, wrapped.subarray(0, 12), wrapped.subarray(12), context(tenantId, keyId)));
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
  open(tenantId: string, connectionId: string, version: number, secret: SealedSecret, dataKey: WrappedDataKey): Promise<Record<string, string>>;
}

const CACHE_MS = 5 * 60_000;
const CACHE_MAX = 10_000;

export function createVault(options: { keys: KeyProvider; store: DataKeyStore; now?: () => number }): Vault {
  const now = options.now ?? Date.now;
  const cache = new Map<string, { key: Uint8Array; until: number }>();
  const cached = (tenantId: string, dataKeyId: string): Uint8Array | null => {
    const hit = cache.get(`${tenantId}\n${dataKeyId}`);
    if (!hit) return null;
    if (hit.until <= now()) {
      cache.delete(`${tenantId}\n${dataKeyId}`);
      return null;
    }
    return hit.key;
  };
  const remember = (tenantId: string, dataKeyId: string, key: Uint8Array) => {
    if (cache.size >= CACHE_MAX) {
      for (const k of cache.keys()) {
        cache.delete(k);
        if (cache.size < CACHE_MAX / 2) break;
      }
    }
    cache.set(`${tenantId}\n${dataKeyId}`, { key, until: now() + CACHE_MS });
  };
  const unwrap = async (tenantId: string, dataKey: WrappedDataKey): Promise<Uint8Array> => {
    const hit = cached(tenantId, dataKey.dataKeyId);
    if (hit) return hit;
    const key = await options.keys.unwrap(dataKey.wrapped, { tenantId, keyId: dataKey.wrappingKeyId });
    if (key.length !== 32) throw new Error("a data key must be 32 bytes");
    remember(tenantId, dataKey.dataKeyId, key);
    return key;
  };
  return {
    async seal(tenantId, connectionId, version, secret) {
      const current = await options.store.currentDataKey(tenantId, async () => ({
        dataKeyId: `dk_${randomBytes(8).toString("hex")}`,
        wrapped: await options.keys.wrap(randomBytes(32), { tenantId }),
        wrappingKeyId: options.keys.keyId,
      }));
      const key = await unwrap(tenantId, current);
      const { iv, sealed } = aesSeal(key, Buffer.from(JSON.stringify(secret), "utf8"), aad(tenantId, connectionId, version));
      return { dataKeyId: current.dataKeyId, iv, sealed };
    },
    async open(tenantId, connectionId, version, secret, dataKey) {
      if (secret.dataKeyId !== dataKey.dataKeyId) throw new Error("the secret is sealed under another data key");
      const key = await unwrap(tenantId, dataKey);
      const plain = aesOpen(key, secret.iv, secret.sealed, aad(tenantId, connectionId, version));
      const parsed: unknown = JSON.parse(plain.toString("utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed) || !Object.values(parsed).every((v) => typeof v === "string")) throw new Error("a sealed secret is not a map of strings");
      return parsed as Record<string, string>;
    },
  };
}
