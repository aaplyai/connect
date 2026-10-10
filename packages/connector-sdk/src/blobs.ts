/**
 * Content by reference: the host's file store, as handlers reach it through
 * `ctx.blobs` (ADR-0008 §3).
 *
 * - The host supplies a {@link BlobStore} scoped by tenant, app and
 *   environment. A handler stores bytes with `ctx.blobs.put` and names the
 *   returned `BlobRef` in its output; it reads one with `ctx.blobs.get`.
 * - **A reference is never a capability on its own.** A call may read only a
 *   reference it was given in its (signed) input or one it stored itself,
 *   bound to the call's scope; the store answers by `(scope, id)`, and the
 *   bytes must be the ones the reference describes.
 * - **Limits are enforced per put and per get** ({@link BlobLimits}).
 * - **Nothing a call stores is left behind silently:** what the call's `ok`
 *   output does not name is deleted when the call ends, without holding up
 *   the answer, and an answer that comes after the deadline names nothing
 *   the call stored (the caller stopped waiting, so no run would hold it).
 *
 * Failures are `ConnectorError`s thrown inside the call (`connect/blob-*`),
 * with outcome semantics like `ctx.http`'s.
 */

import {
  blobDigest,
  checkBlobRef,
  copyBlobRef,
  findBlobRefs,
  formatPath,
  isBlobRefLike,
  jsonByteLength,
  makeBlobRef,
  normalizeMediaType,
  sanitizeBlobName,
  type ActionOutcome,
  type BlobRef,
  type JsonValue,
  type Scope,
  type Sha256Digest,
} from "@aaply/action-contract";
import { ConnectorError, adoptConnectorError } from "./errors.js";

/** Bounds on what one operation call stores and reads. */
export interface BlobLimits {
  /** Largest blob one put stores or one get reads, in bytes. */
  maxBlobBytes: number;
  /** Most blobs one call may store. */
  maxBlobsPerCall: number;
  /** Most bytes one call may store and read together. */
  maxBlobBytesPerCall: number;
}

/** The kit's default {@link BlobLimits}: 25 MiB a blob, 20 puts and 64 MiB a call. */
export const DEFAULT_BLOB_LIMITS: Readonly<BlobLimits> = Object.freeze({
  maxBlobBytes: 25 * 1024 * 1024,
  maxBlobsPerCall: 20,
  maxBlobBytesPerCall: 64 * 1024 * 1024,
});

/** Who is asking the store: the call a put, get or delete belongs to. */
export interface BlobCallContext {
  readonly connectorId: string;
  readonly operation: string;
  readonly connectionId: string;
  /** The effect the call performs, when the call came from an engine. */
  readonly effectId: string | null;
  /** Aborted when the call ends or times out. Absent on the kit's cleanup deletes. */
  readonly signal?: AbortSignal;
}

/** What a put hands the store: the bytes, checked and described by the kit. */
export interface BlobContent {
  readonly bytes: Uint8Array;
  /** `sha256:` and the hex SHA-256 of `bytes`. */
  readonly digest: Sha256Digest;
  /** `bytes.length`. */
  readonly size: number;
  /** Normalised: lower-case `type/subtype`, no parameters. */
  readonly mediaType: string;
  /** Sanitised display label, when the handler gave one. */
  readonly name?: string;
}

/**
 * The host's file store, as the connector kit uses it. Every method takes the
 * call's scope, and every lookup is by `(scope, id)`: a store never answers
 * one scope's content to another.
 */
export interface BlobStore {
  /**
   * Stores `content` in `scope` under a new id the store chooses (never one
   * a caller can pick), and answers its reference: `makeBlobRef(scope, { id,
   * ...content })` from `@aaply/action-contract`. A store may refuse with a
   * `ConnectorError` (a quota, say); any other throw is retryable
   * (`connect/blob-unavailable`).
   */
  put(scope: Scope, content: BlobContent, context: BlobCallContext): Promise<BlobRef>;
  /** The bytes stored in `scope` under `ref.id`, or null when there are none. */
  get(scope: Scope, ref: BlobRef, context: BlobCallContext): Promise<Uint8Array | null>;
  /** Deletes what `scope` holds under `ref.id`. Deleting what is not there is not an error. */
  delete(scope: Scope, ref: BlobRef, context: BlobCallContext): Promise<void>;
}

/** What a handler gets as `ctx.blobs`. */
export interface ConnectorBlobs {
  /**
   * Stores `bytes` in the host's file store and answers their reference, to
   * name in the output. The kit computes the digest and size, normalises the
   * media type and sanitises the name. Unless the call's `ok` output names
   * the reference, the content is deleted when the call ends.
   */
  put(bytes: Uint8Array, options: { mediaType: string; name?: string }): Promise<BlobRef>;
  /**
   * Reads the content of a reference this call was given in its input or
   * stored itself, checked against the reference's size and digest.
   */
  get(ref: BlobRef): Promise<Uint8Array>;
}

/** What the kit tells the host about a store failure. */
export type BlobErrorReporter = (error: unknown, where: string) => void;

function blobError(code: string, message: string, detail?: string): ConnectorError {
  return ConnectorError.final(code, message, detail !== undefined ? { detail } : {});
}

/**
 * Checks every reference in an operation's input against the call's scope:
 * well-formed, and bound to `scope`. Null when all are; otherwise the
 * refusal (`connect/invalid-input`, final), before anything runs.
 */
export function checkBlobInput(input: unknown, scope: Scope): ActionOutcome | null {
  for (const found of findBlobRefs(input)) {
    const problem = checkBlobRef(found.value, scope);
    if (problem) {
      const what = problem.code === "foreign" ? "a file reference made for another workspace, or changed since" : `a malformed file reference (${problem.message})`;
      return { status: "final", error: { code: "connect/invalid-input", message: `Invalid input at ${formatPath(found.path)}: ${what}.` } };
    }
  }
  return null;
}

/** Options of {@link BlobSession}. */
export interface BlobSessionOptions {
  store?: BlobStore;
  /** The call's scope. Without one, the call can neither store nor read, and names no reference in its output. */
  scope?: Scope;
  limits?: Partial<BlobLimits>;
  context: BlobCallContext;
  onError?: BlobErrorReporter;
}

/**
 * One operation call's `ctx.blobs`: its grants, its budget, and what it
 * stored. Created by the kit for each call; `accept` checks the call's output
 * and `close` deletes what the output did not keep.
 */
export class BlobSession {
  /** The handler's `ctx.blobs`. */
  readonly blobs: ConnectorBlobs;
  private readonly options: BlobSessionOptions;
  private readonly limits: BlobLimits;
  /** References the call may read, by binding: those in its input, then those it stored. */
  private readonly granted = new Map<string, BlobRef>();
  /** References the call stored, by binding. */
  private readonly made = new Map<string, BlobRef>();
  /** Bindings the accepted output names. */
  private readonly kept = new Set<string>();
  private puts = 0;
  private bytes = 0;
  private closed = false;
  private readonly cleanups: Array<Promise<void>> = [];

  constructor(options: BlobSessionOptions, input: unknown) {
    this.options = options;
    this.limits = { ...DEFAULT_BLOB_LIMITS, ...options.limits };
    if (options.scope) {
      for (const found of findBlobRefs(input)) {
        if (checkBlobRef(found.value, options.scope) === null) {
          const ref = found.value as unknown as BlobRef;
          this.granted.set(ref.binding, copyBlobRef(ref));
        }
      }
    }
    this.blobs = Object.freeze({
      put: (bytes: Uint8Array, putOptions: { mediaType: string; name?: string }) => this.put(bytes, putOptions),
      get: (ref: BlobRef) => this.get(ref),
    });
  }

  private ready(): { store: BlobStore; scope: Scope } {
    if (this.closed) throw blobError("connect/closed", "The operation call has finished; its file store is closed.");
    const { store, scope } = this.options;
    if (!store || !scope) throw blobError("connect/blob-no-store", "This performer has no file store.");
    return { store, scope };
  }

  private failure(error: unknown, where: string): ConnectorError {
    // The store's own refusal, by its fields only: the handler gets a ConnectorError of the kit's.
    const refusal = adoptConnectorError(error);
    if (refusal) return refusal;
    this.options.onError?.(error, where);
    return ConnectorError.retryable("connect/blob-unavailable", "The file store could not be reached.", { cause: error });
  }

  private async put(bytes: Uint8Array, putOptions: { mediaType: string; name?: string }): Promise<BlobRef> {
    const { store, scope } = this.ready();
    if (!(bytes instanceof Uint8Array)) throw blobError("connect/blob-invalid", "ctx.blobs.put stores a Uint8Array.");
    const mediaType = normalizeMediaType((putOptions as { mediaType?: unknown } | undefined)?.mediaType);
    if (mediaType === null) throw blobError("connect/blob-invalid", "ctx.blobs.put needs a media type such as application/pdf.");
    const rawName = (putOptions as { name?: unknown }).name;
    const name = rawName === undefined || rawName === null ? null : sanitizeBlobName(rawName);
    const size = bytes.length;
    if (size > this.limits.maxBlobBytes) throw blobError("connect/blob-too-large", `A file may be at most ${this.limits.maxBlobBytes} bytes.`, `${size} bytes`);
    if (this.puts + 1 > this.limits.maxBlobsPerCall) throw blobError("connect/blob-too-many", `An operation call may store at most ${this.limits.maxBlobsPerCall} files.`);
    if (this.bytes + size > this.limits.maxBlobBytesPerCall) {
      throw blobError("connect/blob-too-large", `An operation call may store and read at most ${this.limits.maxBlobBytesPerCall} bytes of files.`);
    }
    // Reserved before the first await, so concurrent puts cannot pass the limits together.
    this.puts += 1;
    this.bytes += size;
    // A copy: the handler may reuse its buffer while the store is writing.
    const content = bytes.slice();
    const digest = await blobDigest(content);
    let ref: unknown;
    try {
      ref = await store.put(scope, { bytes: content, digest, size, mediaType, ...(name !== null ? { name } : {}) }, this.options.context);
    } catch (error) {
      throw this.failure(error, "connector-blobs:put");
    }
    const problem = checkBlobRef(ref, scope);
    const stored = ref as BlobRef;
    if (problem || stored.digest !== digest || stored.size !== size || stored.mediaType !== mediaType) {
      this.options.onError?.(new Error(`the file store answered a reference that does not describe what was stored${problem ? ` (${problem.message})` : ""}`), "connector-blobs:put");
      if (problem === null || problem.code === "foreign") this.discard(stored, this.cleanupContext());
      throw blobError("connect/blob-corrupt", "The file store answered a reference that does not describe the stored file.");
    }
    if (this.closed) {
      // The call ended while the store was writing: nothing can name this reference now.
      this.discard(stored, this.cleanupContext());
      throw blobError("connect/closed", "The operation call has finished; its file store is closed.");
    }
    const own = copyBlobRef(stored);
    this.made.set(own.binding, own);
    this.granted.set(own.binding, own);
    return copyBlobRef(own);
  }

  private async get(ref: BlobRef): Promise<Uint8Array> {
    const { store, scope } = this.ready();
    const problem = checkBlobRef(ref, scope);
    if (problem?.code === "malformed") throw blobError("connect/blob-invalid", `ctx.blobs.get needs a file reference: ${problem.message}.`);
    if (problem) throw blobError("connect/blob-foreign", "That file reference was made for another workspace, or changed since.");
    const grant = this.granted.get(ref.binding);
    if (!grant) throw blobError("connect/blob-not-granted", "This call may read only the files in its input and those it stored.");
    if (grant.size > this.limits.maxBlobBytes) throw blobError("connect/blob-too-large", `A file may be at most ${this.limits.maxBlobBytes} bytes.`, `${grant.size} bytes`);
    if (this.bytes + grant.size > this.limits.maxBlobBytesPerCall) {
      throw blobError("connect/blob-too-large", `An operation call may store and read at most ${this.limits.maxBlobBytesPerCall} bytes of files.`);
    }
    this.bytes += grant.size;
    let bytes: unknown;
    try {
      bytes = await store.get(scope, copyBlobRef(grant), this.options.context);
    } catch (error) {
      throw this.failure(error, "connector-blobs:get");
    }
    if (bytes === null || bytes === undefined) throw blobError("connect/blob-not-found", "The file is no longer stored.");
    if (!(bytes instanceof Uint8Array) || bytes.length !== grant.size || (await blobDigest(bytes)) !== grant.digest) {
      this.options.onError?.(new Error(`the file store answered other bytes than ${grant.id} describes`), "connector-blobs:get");
      throw blobError("connect/blob-corrupt", "The stored file does not match its reference.");
    }
    if (this.closed) throw blobError("connect/closed", "The operation call has finished; its file store is closed.");
    return bytes;
  }

  /**
   * Checks the references in an outcome the kit is about to answer: each in
   * an `ok` output must be bound to the call's scope and be one the call was
   * given or stored, or the output is bad (`connect/bad-output`: final for a
   * read, unknown for a write). Records which stored references the output
   * keeps.
   */
  accept(outcome: ActionOutcome, effect: "read" | "write"): ActionOutcome {
    if (outcome.status !== "ok" || outcome.output === null) return outcome;
    const bad = (message: string): ActionOutcome =>
      effect === "write" ? { status: "unknown", error: { code: "connect/bad-output", message } } : { status: "final", error: { code: "connect/bad-output", message } };
    const named = new Set<string>();
    for (const found of findBlobRefs(outcome.output as JsonValue)) {
      const at = formatPath(found.path);
      const problem = this.options.scope ? checkBlobRef(found.value, this.options.scope) : { code: "foreign" as const, message: "the call has no scope" };
      if (problem?.code === "malformed") return bad(`The connector returned a malformed file reference at ${at}: ${problem.message}.`);
      if (problem) return bad(`The connector returned a file reference at ${at} made for another workspace, or changed since.`);
      const binding = (found.value as unknown as BlobRef).binding;
      if (!this.granted.has(binding)) return bad(`The connector returned a file reference at ${at} that the call was not given and did not store.`);
      named.add(binding);
    }
    for (const binding of named) this.kept.add(binding);
    return outcome;
  }

  /**
   * The answer for a caller that has stopped waiting (the call's deadline
   * passed): an `ok` output that names a file the call stored would reach no
   * run, so it is withheld and the file deleted with the rest at
   * {@link close}. A write stays applied (`ok`, `output: null`, `withheld`);
   * a read becomes `retryable` (`connect/timeout`), so a caller still waiting
   * asks again. Any other answer is returned as it is.
   */
  withholdLate(outcome: ActionOutcome, effect: "read" | "write"): ActionOutcome {
    if (outcome.status !== "ok" || ![...this.kept].some((binding) => this.made.has(binding))) return outcome;
    this.kept.clear();
    if (effect === "read") return { status: "retryable", error: { code: "connect/timeout", message: "The operation did not finish in time." } };
    return { status: "ok", output: null, withheld: { bytes: jsonByteLength(outcome.output) } };
  }

  /**
   * Ends the session: no further put or get, and every reference the call
   * stored that the accepted output does not name is deleted. The deletes
   * start at once; the promise settles when they are done and never
   * rejects (a delete that fails is reported). The kit answers without
   * waiting for it, so a slow store never makes an answer late.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const context = this.cleanupContext();
    for (const [binding, ref] of this.made) if (!this.kept.has(binding)) this.discard(ref, context);
    await Promise.all(this.cleanups);
  }

  private cleanupContext(): BlobCallContext {
    const { signal: _signal, ...rest } = this.options.context;
    return rest;
  }

  private discard(ref: BlobRef, context: BlobCallContext): void {
    const store = this.options.store;
    const scope = this.options.scope;
    if (!store || !scope || !isBlobRefLike(ref)) return;
    this.cleanups.push(
      Promise.resolve()
        .then(() => store.delete(scope, copyBlobRef(ref), context))
        .catch((error: unknown) => this.options.onError?.(error, "connector-blobs:cleanup")),
    );
  }
}

/** A {@link BlobStore} in memory, with what a test needs to look inside it. */
export interface MemoryBlobStore extends BlobStore {
  /** Every reference stored in `scope`, oldest first. */
  list(scope: Scope): BlobRef[];
  /** How many blobs the store holds, across scopes. */
  readonly count: number;
  /** Every delete the store was asked for, in order. */
  readonly deletes: ReadonlyArray<{ scope: Scope; id: string }>;
}

const scopeKey = (scope: Scope): string => JSON.stringify([scope.tenantId, scope.appId, scope.environmentId]);

/**
 * The reference {@link BlobStore}, in memory: for tests and a host that runs
 * in one process. Ids are unguessable; content is copied in and out, and a
 * get answers only a reference whose described content matches what is
 * stored under its id in its scope.
 */
export function memoryBlobStore(): MemoryBlobStore {
  const blobs = new Map<string, Map<string, { ref: BlobRef; bytes: Uint8Array }>>();
  const deletes: Array<{ scope: Scope; id: string }> = [];
  const space = (scope: Scope) => {
    const key = scopeKey(scope);
    let found = blobs.get(key);
    if (!found) blobs.set(key, (found = new Map()));
    return found;
  };
  const newId = (): string => {
    const random = new Uint8Array(16);
    globalThis.crypto.getRandomValues(random);
    return `blob_${Array.from(random, (b) => b.toString(16).padStart(2, "0")).join("")}`;
  };
  return {
    async put(scope, content) {
      const ref = makeBlobRef(scope, { id: newId(), digest: content.digest, size: content.size, mediaType: content.mediaType, ...(content.name !== undefined ? { name: content.name } : {}) });
      space(scope).set(ref.id, { ref, bytes: content.bytes.slice() });
      return copyBlobRef(ref);
    },
    async get(scope, ref) {
      const held = blobs.get(scopeKey(scope))?.get(ref.id);
      if (!held || held.ref.digest !== ref.digest || held.ref.size !== ref.size || held.ref.mediaType !== ref.mediaType) return null;
      return held.bytes.slice();
    },
    async delete(scope, ref) {
      deletes.push({ scope: { ...scope }, id: ref.id });
      blobs.get(scopeKey(scope))?.delete(ref.id);
    },
    list(scope) {
      return [...(blobs.get(scopeKey(scope))?.values() ?? [])].map((held) => copyBlobRef(held.ref));
    },
    get count() {
      let n = 0;
      for (const held of blobs.values()) n += held.size;
      return n;
    },
    deletes,
  };
}
