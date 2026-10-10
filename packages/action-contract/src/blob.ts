/**
 * Blob references: how large or binary content (a file a person uploads, a
 * PDF a connector downloads, an image a section shows) is named without its
 * bytes. The host stores the bytes; runs, events, envelopes and views carry a
 * small JSON {@link BlobRef}.
 *
 * A reference is never a capability on its own. Its `binding` ties it to one
 * scope (tenant, app and environment) so every side can refuse, without a
 * lookup, a reference made for another; it is an unkeyed digest and grants
 * nothing. Whoever owns the bytes still looks each use up by scope and id
 * (the kit's `BlobStore`, the engine's vouch port and URL resolver).
 *
 * The schema subset's `blob` keyword (see `schema.ts`) types a value as a
 * reference, optionally narrowed to some media types and a largest size.
 */

import { deepFreeze } from "./frozen.js";
import { isSha256Digest, type Sha256Digest } from "./digest.js";
import { sha256, toHex } from "./hash.js";
import { canonicalJson, isJsonObject, MAX_JSON_DEPTH, type JsonValue, type PathSegment } from "./json.js";
import type { JsonSchema } from "./schema.js";
import type { Scope } from "./scope.js";

/** The reference format's version, the value of its `$blob` key. */
export const BLOB_REF_VERSION = 1 as const;

/** The key that marks an object as a blob reference. Walkers find references by it alone. */
export const BLOB_REF_KEY = "$blob";

/** Longest `id` a reference may carry. */
export const MAX_BLOB_ID_LENGTH = 256;

/** Longest `name` (in characters) a reference may carry. */
export const MAX_BLOB_NAME_LENGTH = 255;

/** Most media types a `blob` schema may list. */
export const MAX_BLOB_MEDIA_TYPES = 32;

/**
 * Content stored by the host, by reference. Plain JSON with exactly these
 * keys; see {@link checkBlobRef}.
 */
export interface BlobRef {
  /** Marks the object as a reference: always {@link BLOB_REF_VERSION}. */
  $blob: typeof BLOB_REF_VERSION;
  /** The host store's id for the content, unique within its scope (1-256 printable ASCII, no space). */
  id: string;
  /** `sha256:` and the hex SHA-256 of the bytes ({@link blobDigest}). */
  digest: Sha256Digest;
  /** The bytes' length. */
  size: number;
  /** Lower-case `type/subtype`, without parameters ({@link normalizeMediaType}). */
  mediaType: string;
  /** A display label: no control characters, no path separators. Not bound: a label, never an authority. */
  name?: string;
  /** {@link blobBinding} of the scope it was stored in and the fields above but `name`. */
  binding: Sha256Digest;
}

/** Why a value is not a usable reference: not one at all (`malformed`), or bound to another scope (`foreign`). */
export interface BlobRefProblem {
  code: "malformed" | "foreign";
  message: string;
}

/** What a `blob` schema narrows a reference to. */
export interface BlobConstraint {
  /** Accepted media types: exact (`application/pdf`) or a whole type (`image/*`). Absent: any. */
  mediaTypes?: string[];
  /** Largest `size` accepted, in bytes. Absent: any. */
  maxBytes?: number;
}

const ID_RE = /^[\x21-\x7e]+$/;
const TOKEN = "[a-z0-9][a-z0-9!#$&^_.+-]{0,126}";
const MEDIA_TYPE_RE = new RegExp(`^${TOKEN}/${TOKEN}$`);
const MEDIA_PATTERN_RE = new RegExp(`^${TOKEN}/(?:${TOKEN}|\\*)$`);
/** C0 and C1 controls, DEL, and the bidirectional controls that let a name read as another (`invoice‮fdp.exe`). */
const UNSAFE_NAME_CHARS = /[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/u;
const UNSAFE_NAME_CHARS_ALL = /[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/gu;
const LONE_SURROGATE = /\p{Cs}/u;
const LONE_SURROGATE_ALL = /\p{Cs}/gu;
const REF_KEYS = new Set([BLOB_REF_KEY, "id", "digest", "size", "mediaType", "name", "binding"]);
const BINDING_TAG = "aaply.blob-ref.1\n";

/** True for a plain object that carries the {@link BLOB_REF_KEY} marker: something meant as a reference, well-formed or not. */
export function isBlobRefLike(value: unknown): value is Record<string, unknown> {
  return isJsonObject(value as JsonValue) && Object.prototype.hasOwnProperty.call(value, BLOB_REF_KEY);
}

/** A lower-case `type/subtype` without parameters (`Application/PDF; q=1` is `application/pdf`), or null when it is not one. */
export function normalizeMediaType(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 1024) return null;
  const essence = value.split(";", 1)[0]!.trim().toLowerCase();
  return MEDIA_TYPE_RE.test(essence) ? essence : null;
}

/** True for a media type a `blob` schema may list: an exact lower-case `type/subtype`, or `type/*`. */
export function isMediaTypePattern(value: unknown): value is string {
  return typeof value === "string" && MEDIA_PATTERN_RE.test(value);
}

/** Whether `mediaType` is accepted by `pattern` (equal, or `pattern` is `type/*` of its type). */
export function mediaTypeMatches(pattern: string, mediaType: string): boolean {
  if (pattern.endsWith("/*")) return mediaType.startsWith(pattern.slice(0, -1));
  return pattern === mediaType;
}

function codePoints(value: string): number {
  let n = 0;
  for (const _ of value) n++;
  return n;
}

/** True for a name a reference may carry (see {@link BlobRef.name}). */
export function isBlobName(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || LONE_SURROGATE.test(value) || UNSAFE_NAME_CHARS.test(value)) return false;
  if (value.includes("/") || value.includes("\\") || value === "." || value === "..") return false;
  if (value.trim() !== value) return false;
  return codePoints(value) <= MAX_BLOB_NAME_LENGTH;
}

/**
 * A name a reference may carry, made from any label (a service's file name):
 * controls and bidirectional overrides removed, path separators replaced with
 * `_`, trimmed, cut to {@link MAX_BLOB_NAME_LENGTH} characters. Null when
 * nothing usable is left.
 */
export function sanitizeBlobName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(LONE_SURROGATE_ALL, "").replace(UNSAFE_NAME_CHARS_ALL, "").replace(/[/\\]/g, "_").trim();
  const cut = [...cleaned].slice(0, MAX_BLOB_NAME_LENGTH).join("").trim();
  return isBlobName(cut) ? cut : null;
}

/**
 * The binding of a reference to one scope: `sha256:` of a fixed tag and the
 * canonical JSON of the scope, `id`, `digest`, `size` and `mediaType`.
 * Anyone who knows the scope can compute it: it is a check, never a grant.
 */
export function blobBinding(scope: Scope, parts: Pick<BlobRef, "id" | "digest" | "size" | "mediaType">): Sha256Digest {
  const body = canonicalJson({
    scope: { tenantId: scope.tenantId, appId: scope.appId, environmentId: scope.environmentId },
    id: parts.id,
    digest: parts.digest,
    size: parts.size,
    mediaType: parts.mediaType,
  });
  return `sha256:${toHex(sha256(BINDING_TAG + body))}`;
}

/** The first malformed field of a reference-like value, or null. */
function shapeProblem(value: unknown): string | null {
  if (!isJsonObject(value as JsonValue)) return "a file reference must be an object";
  const v = value as Record<string, unknown>;
  for (const key of Object.keys(v)) if (!REF_KEYS.has(key)) return `a file reference has no field "${key}"`;
  if (v[BLOB_REF_KEY] !== BLOB_REF_VERSION) return `${BLOB_REF_KEY} must be ${BLOB_REF_VERSION}`;
  if (typeof v.id !== "string" || v.id.length === 0 || v.id.length > MAX_BLOB_ID_LENGTH || !ID_RE.test(v.id)) return "id must be 1-256 printable ASCII characters without spaces";
  if (!isSha256Digest(v.digest)) return "digest must be sha256: and 64 lower-case hex digits";
  if (typeof v.size !== "number" || !Number.isSafeInteger(v.size) || v.size < 0) return "size must be a whole number of bytes";
  if (typeof v.mediaType !== "string" || normalizeMediaType(v.mediaType) !== v.mediaType) return "mediaType must be a lower-case type/subtype without parameters";
  if (v.name !== undefined && !isBlobName(v.name)) return "name must be 1-255 characters without control characters, path separators or surrounding spaces";
  if (!isSha256Digest(v.binding)) return "binding must be sha256: and 64 lower-case hex digits";
  return null;
}

/**
 * Checks that `value` is a well-formed reference (exactly the fields of
 * {@link BlobRef}) and, given a `scope`, that it is bound to that scope.
 * Null when it is; never throws.
 */
export function checkBlobRef(value: unknown, scope?: Scope): BlobRefProblem | null {
  let problem: string | null;
  try {
    problem = shapeProblem(value);
  } catch {
    problem = "the file reference could not be read";
  }
  if (problem) return { code: "malformed", message: problem };
  if (scope === undefined) return null;
  const ref = value as BlobRef;
  return blobBinding(scope, ref) === ref.binding ? null : { code: "foreign", message: "the file reference belongs to another tenant, app or environment" };
}

/** True when {@link checkBlobRef} finds nothing wrong. */
export function isBlobRef(value: unknown, scope?: Scope): value is BlobRef {
  return checkBlobRef(value, scope) === null;
}

/**
 * Builds the reference a host store answers for content it stored in
 * `scope`: normalises the media type and the name and computes the binding.
 * Throws a `TypeError` when a part cannot be in a reference.
 */
export function makeBlobRef(scope: Scope, parts: { id: string; digest: string; size: number; mediaType: string; name?: string | null }): BlobRef {
  const mediaType = normalizeMediaType(parts.mediaType);
  if (mediaType === null) throw new TypeError("makeBlobRef: mediaType must be type/subtype");
  const name = parts.name === undefined || parts.name === null ? null : sanitizeBlobName(parts.name);
  const draft = { [BLOB_REF_KEY]: BLOB_REF_VERSION, id: parts.id, digest: parts.digest, size: parts.size, mediaType, ...(name !== null ? { name } : {}) } as Omit<BlobRef, "binding">;
  const ref = { ...draft, binding: blobBinding(scope, draft as BlobRef) } as BlobRef;
  const problem = checkBlobRef(ref, scope);
  if (problem) throw new TypeError(`makeBlobRef: ${problem.message}`);
  return ref;
}

/** A detached copy of a well-formed reference, with exactly its own fields. */
export function copyBlobRef(ref: BlobRef): BlobRef {
  return {
    [BLOB_REF_KEY]: BLOB_REF_VERSION,
    id: ref.id,
    digest: ref.digest,
    size: ref.size,
    mediaType: ref.mediaType,
    ...(ref.name !== undefined ? { name: ref.name } : {}),
    binding: ref.binding,
  } as BlobRef;
}

/** The digest a reference carries for these bytes, computed without WebCrypto. */
export function blobDigestSync(bytes: Uint8Array): Sha256Digest {
  return `sha256:${toHex(sha256(bytes))}`;
}

/** The digest a reference carries for these bytes: SHA-256, with WebCrypto where the platform has it. */
export async function blobDigest(bytes: Uint8Array): Promise<Sha256Digest> {
  const subtle = (globalThis as { crypto?: { subtle?: { digest(alg: string, data: Uint8Array): Promise<ArrayBuffer> } } }).crypto?.subtle;
  if (subtle) {
    try {
      return `sha256:${toHex(new Uint8Array(await subtle.digest("SHA-256", bytes)))}`;
    } catch {
      // A platform whose digest refuses this input: the portable one gives the same answer.
    }
  }
  return blobDigestSync(bytes);
}

/** A reference-like value found in a JSON value, and where. */
export interface FoundBlobRef {
  path: PathSegment[];
  value: Record<string, unknown>;
}

/**
 * Every reference-like value ({@link isBlobRefLike}) inside `value`, in
 * document order, without looking inside one. Stops after `limit` (default
 * unbounded) plus one, so a caller can tell "too many". Walks at most
 * {@link MAX_JSON_DEPTH} levels; never throws.
 */
export function findBlobRefs(value: unknown, options: { limit?: number } = {}): FoundBlobRef[] {
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  const found: FoundBlobRef[] = [];
  const walk = (v: unknown, path: PathSegment[], depth: number): boolean => {
    if (depth > MAX_JSON_DEPTH || v === null || typeof v !== "object") return true;
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) if (!walk(v[i], [...path, i], depth + 1)) return false;
      return true;
    }
    if (!isJsonObject(v as JsonValue)) return true;
    if (isBlobRefLike(v)) {
      found.push({ path, value: v });
      return found.length <= limit;
    }
    for (const key of Object.keys(v)) if (!walk((v as Record<string, unknown>)[key], [...path, key], depth + 1)) return false;
    return true;
  };
  try {
    walk(value, [], 0);
  } catch {
    // A hostile value (a throwing getter): what was found so far.
  }
  return found;
}

/** True when `value` holds any reference-like value. */
export function hasBlobRefs(value: unknown): boolean {
  return findBlobRefs(value, { limit: 0 }).length > 0;
}

/**
 * A copy of `value` in which `change` replaced every reference-like value;
 * everything else is shared, not copied, and `value` itself is never changed.
 */
export function mapBlobRefs<T>(value: T, change: (ref: Record<string, unknown>, path: PathSegment[]) => unknown): T {
  const walk = (v: unknown, path: PathSegment[], depth: number): unknown => {
    if (depth > MAX_JSON_DEPTH || v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) {
      let out: unknown[] | null = null;
      for (let i = 0; i < v.length; i++) {
        const next = walk(v[i], [...path, i], depth + 1);
        if (next !== v[i]) (out ??= [...v])[i] = next;
      }
      return out ?? v;
    }
    if (!isJsonObject(v as JsonValue)) return v;
    if (isBlobRefLike(v)) return change(v, path);
    let out: Record<string, unknown> | null = null;
    for (const key of Object.keys(v)) {
      const item = (v as Record<string, unknown>)[key];
      const next = walk(item, [...path, key], depth + 1);
      if (next !== item) {
        out ??= { ...(v as Record<string, unknown>) };
        Object.defineProperty(out, key, { value: next, enumerable: true, writable: true, configurable: true });
      }
    }
    return out ?? v;
  };
  return walk(value, [], 0) as T;
}

// ---------------------------------------------------------------------------
// The `blob` schema keyword
// ---------------------------------------------------------------------------

/** The options a `blob` keyword's object may hold (frozen). */
export const BLOB_CONSTRAINT_KEYS = Object.freeze(["mediaTypes", "maxBytes"] as const) satisfies ReadonlyArray<keyof BlobConstraint>;
const CONSTRAINT_KEYS = new Set<string>(BLOB_CONSTRAINT_KEYS);

/** Why a `blob` keyword's value is not one, or null. */
export function blobConstraintProblem(value: unknown): string | null {
  if (value === true) return null;
  if (!isJsonObject(value as JsonValue)) return "blob must be true or an object with mediaTypes and maxBytes";
  const c = value as Record<string, unknown>;
  for (const key of Object.keys(c)) if (!CONSTRAINT_KEYS.has(key)) return `blob has no option "${key}"`;
  if (c.mediaTypes !== undefined) {
    if (!Array.isArray(c.mediaTypes) || c.mediaTypes.length === 0 || c.mediaTypes.length > MAX_BLOB_MEDIA_TYPES) return `blob.mediaTypes must list 1 to ${MAX_BLOB_MEDIA_TYPES} media types`;
    for (const t of c.mediaTypes) if (!isMediaTypePattern(t)) return `blob.mediaTypes: ${JSON.stringify(t)} is not a lower-case type/subtype or type/*`;
    if (new Set(c.mediaTypes).size !== c.mediaTypes.length) return "blob.mediaTypes lists a media type twice";
  }
  if (c.maxBytes !== undefined && !(typeof c.maxBytes === "number" && Number.isSafeInteger(c.maxBytes) && c.maxBytes > 0)) return "blob.maxBytes must be a positive whole number of bytes";
  return null;
}

/** Why `value` is not a reference a `blob` schema with `constraint` accepts, or null. A schema knows no scope, so the binding is not checked here. */
export function blobValueProblem(constraint: true | BlobConstraint, value: JsonValue): string | null {
  const problem = checkBlobRef(value);
  if (problem) return `must be a file reference: ${problem.message}`;
  if (constraint === true) return null;
  const ref = value as unknown as BlobRef;
  if (constraint.mediaTypes !== undefined && !constraint.mediaTypes.some((p) => mediaTypeMatches(p, ref.mediaType))) return `files of type ${ref.mediaType} are not accepted`;
  if (constraint.maxBytes !== undefined && ref.size > constraint.maxBytes) return `the file must be at most ${constraint.maxBytes} bytes`;
  return null;
}

/** Why a `blob` schema with constraint `from` may give a reference that one with `to` refuses, or null when `to` covers it. */
export function blobConstraintCovers(from: true | BlobConstraint, to: true | BlobConstraint): string | null {
  if (to === true) return null;
  const f = from === true ? {} : from;
  if (to.mediaTypes !== undefined) {
    if (f.mediaTypes === undefined) return `receiving side accepts only ${to.mediaTypes.join(", ")}; sending side accepts any media type`;
    for (const t of f.mediaTypes) {
      const covered = to.mediaTypes.some((p) => (p.endsWith("/*") ? t.startsWith(p.slice(0, -1)) : p === t));
      if (!covered) return `receiving side does not accept ${t}`;
    }
  }
  if (to.maxBytes !== undefined && (f.maxBytes === undefined || f.maxBytes > to.maxBytes)) return `receiving side accepts files of at most ${to.maxBytes} bytes`;
  return null;
}

/**
 * True when a schema, or any schema inside it (`properties`, `items`,
 * `additionalProperties`, `anyOf`), uses the `blob` keyword. Values such as
 * `const`, `enum` and `default` are data, not schemas, and are not looked
 * into. Never throws.
 */
export function schemaUsesBlob(schema: unknown): boolean {
  const walk = (s: unknown, depth: number): boolean => {
    if (depth > 64 || !isJsonObject(s as JsonValue)) return false;
    const o = s as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(o, "blob")) return true;
    if (isJsonObject(o.properties as JsonValue) && Object.values(o.properties as Record<string, unknown>).some((p) => walk(p, depth + 1))) return true;
    if (walk(o.items, depth + 1) || walk(o.additionalProperties, depth + 1)) return true;
    return Array.isArray(o.anyOf) && o.anyOf.some((a) => walk(a, depth + 1));
  };
  try {
    return walk(schema, 0);
  } catch {
    return false;
  }
}

const DIGEST_PATTERN = "^sha256:[0-9a-f]{64}$";

/**
 * A reference's shape as a plain schema, with `url` (the address a view
 * gives it) optional: what a `blob` schema reads as on a receiving side that
 * does not say `blob`, such as a Facet section's input.
 */
export const BLOB_REF_SCHEMA: Readonly<JsonSchema> = deepFreeze({
  type: "object",
  required: [BLOB_REF_KEY, "id", "digest", "size", "mediaType", "binding"],
  properties: {
    [BLOB_REF_KEY]: { const: BLOB_REF_VERSION },
    id: { type: "string", minLength: 1, maxLength: MAX_BLOB_ID_LENGTH },
    digest: { type: "string", pattern: DIGEST_PATTERN },
    size: { type: "integer", minimum: 0 },
    mediaType: { type: "string", minLength: 3 },
    name: { type: "string", minLength: 1, maxLength: MAX_BLOB_NAME_LENGTH },
    binding: { type: "string", pattern: DIGEST_PATTERN },
    url: { type: ["string", "null"] },
  },
  additionalProperties: false,
} satisfies JsonSchema) as Readonly<JsonSchema>;
