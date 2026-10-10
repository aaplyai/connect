/**
 * Content digests that travel between servers: `sha256:` and the lower-case
 * hex SHA-256 of a value's canonical JSON. Unsalted, so either side can
 * recompute one from the value alone; never shown to clients (the engine
 * salts what clients see).
 */

import { sha256, toHex } from "./hash.js";
import { canonicalJson, type JsonValue } from "./json.js";

/** A `sha256:<64 hex>` digest. */
export type Sha256Digest = `sha256:${string}`;

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

/** The digest of a JSON value: SHA-256 of its canonical form. */
export function sha256Digest(value: JsonValue): Sha256Digest {
  return `sha256:${toHex(sha256(canonicalJson(value)))}`;
}

/** True for a well-formed `sha256:` digest. */
export function isSha256Digest(value: unknown): value is Sha256Digest {
  return typeof value === "string" && DIGEST_RE.test(value);
}
