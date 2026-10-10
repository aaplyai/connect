/**
 * File references at the runtime's edges (ADR-0008 §4, §5). The engine never
 * holds a file's bytes, only `BlobRef`s, and a reference is never a
 * capability on its own:
 *
 * - every reference a caller gives the runtime (a person's upload, staff's
 *   resolution, an event) is checked against the call's scope and vouched for
 *   by the host's {@link BlobHost} before anything is applied;
 * - every reference a performer answers is checked against the run's scope;
 * - a view's references carry a `url` the host resolves per response, and a
 *   `url` sent back is removed before anything is stored;
 * - an export lists the references it holds, and an erasure the references it
 *   released, recorded with each erasure in the store's blob ledger
 *   (`blob-release.ts`).
 *
 * Pure helpers: the runtime and `runtime-blobs.ts` call them.
 */

import {
  checkBlobRef,
  copyBlobRef,
  findBlobRefs,
  formatPath,
  hasBlobRefs,
  isBlobRefLike,
  isJsonObject,
  type ActionEffectKind,
  type ActionOutcome,
  type BlobRef,
  type JsonValue,
  type PathSegment,
} from "@aaply/action-contract";
import type { TrustedContext } from "./ports.js";
import type { Scope } from "./state.js";

/** The codes of this module, as literals (found by `docs-codes.test.ts`). */
export const BLOB_CODES = Object.freeze({
  invalid: "flow/blob-invalid",
  foreign: "flow/blob-foreign",
  unvouched: "flow/blob-unvouched",
  tooMany: "flow/blob-too-many",
} as const);

/** Most file references one input may give the runtime. */
export const MAX_INPUT_BLOB_REFS = 100;

/** Longest URL a view carries for a reference; a longer one is dropped. */
export const MAX_BLOB_URL_LENGTH = 2048;

/** How a reference reached the runtime. */
export type BlobArrival = "start" | "submit" | "deliver" | "resolve";

/** What the runtime asks the host before accepting a reference ({@link BlobHost.vouch}). */
export interface BlobVouchRequest {
  /** The call's scope; the reference is already known to be bound to it. */
  scope: Scope;
  /** The reference, without any `url` a view gave it. */
  ref: BlobRef;
  /** Who gave it: the trusted context's actor, and the person they act for when they do. */
  actor: TrustedContext["actor"];
  subject?: TrustedContext["subject"];
  via: BlobArrival;
  /**
   * The run it is given to: for a start, the run the start creates (see
   * `flowId`); for an event, the run its correlation found. A host that lets
   * one upload reach several runs counts its uses by this id.
   */
  runId: string;
  /** For a start: the flow the new run is of. */
  flowId?: string;
  /** Where in the call's input, for example `facts.invoice` or `payload.files[0]`. */
  path: string;
  requestId: string;
}

/** Who a view's URL is for ({@link BlobHost.resolveBlobUrl}). */
export interface BlobUrlContext {
  /** The run whose view shows the reference; null when the response names none. */
  runId: string | null;
  viewer: TrustedContext["actor"];
  requestId: string;
}

/**
 * The host's file store, as the runtime sees it (`RuntimeOptions.blobs`). The
 * runtime never reads bytes and never builds a URL.
 */
export interface BlobHost {
  /**
   * Whether the host issued this reference in this scope and the caller may
   * give it to this run: an upload of this person, finished and scanned,
   * whose reservation has not expired. Answer `true` to accept; anything else
   * refuses the whole input (`flow/blob-unvouched`). A throw refuses it as
   * `unavailable`. A check, not a claim: the runtime may still refuse the
   * input afterwards for another reason, and a retried call asks again.
   */
  vouch(request: BlobVouchRequest): boolean | Promise<boolean>;
  /**
   * The address a viewer opens the content at: `https`, at most 2048
   * characters, preferably short-lived and bound to the viewer. Asked per
   * response for every reference a view shows; null when there is none (the
   * content is gone, the viewer may not see it). Without it, every `url` is
   * null.
   */
  resolveBlobUrl?(scope: Scope, ref: BlobRef, context: BlobUrlContext): string | null | Promise<string | null>;
}

/** A refusal of an input's references: what the runtime throws, as `FlowError` data. */
export interface BlobRefusal {
  status: "invalid" | "unavailable";
  message: string;
}

/**
 * The scope `value` names, as a new plain object of its three string ids, or
 * null when they cannot be read. A host's context may hold its scope as a
 * class instance; every check here reads the scope through this copy, so a
 * scope of any shape is checked, and one that cannot be read refuses every
 * reference instead of letting it pass unchecked. Never throws.
 */
export function readScope(value: unknown): Scope | null {
  try {
    if (typeof value !== "object" || value === null) return null;
    const { tenantId, appId, environmentId } = value as Record<string, unknown>;
    if (typeof tenantId !== "string" || typeof appId !== "string" || typeof environmentId !== "string") return null;
    return { tenantId, appId, environmentId };
  } catch {
    // A getter that throws, or a proxy.
    return null;
  }
}

/**
 * Removes the `url` a view gave each reference in `value`, so a section that
 * sends a reference back sends it as stored. Copy-on-write: `value` itself is
 * returned when nothing changed. Only a `url` that is a string or null on an
 * object with the reference marker is removed.
 */
export function stripBlobUrls<T>(value: T): T {
  const walk = (v: unknown, depth: number): unknown => {
    if (depth > 64 || typeof v !== "object" || v === null) return v;
    if (Array.isArray(v)) {
      let out: unknown[] | null = null;
      v.forEach((item, i) => {
        const next = walk(item, depth + 1);
        if (next !== item) (out ??= v.slice())[i] = next;
      });
      return out ?? v;
    }
    if (isBlobRefLike(v)) {
      if (!Object.prototype.hasOwnProperty.call(v, "url") || (typeof v.url !== "string" && v.url !== null)) return v;
      const { url: _url, ...rest } = v;
      return rest;
    }
    const o = v as Record<string, unknown>;
    let out: Record<string, unknown> | null = null;
    for (const key of Object.keys(o)) {
      const next = walk(o[key], depth + 1);
      if (next !== o[key]) {
        out ??= { ...o };
        Object.defineProperty(out, key, { value: next, enumerable: true, writable: true, configurable: true });
      }
    }
    return out ?? v;
  };
  return walk(value, 0) as T;
}

/**
 * Checks every reference in a caller's input: at most
 * {@link MAX_INPUT_BLOB_REFS}, each well-formed and bound to the call's scope
 * (read with {@link readScope}; one that cannot be read refuses them all),
 * each vouched for by `host`. Null when the input may be applied; otherwise
 * the refusal. `prefix` names where the input sits (`facts`, `payload`).
 */
export async function vouchBlobRefs(
  host: BlobHost | undefined,
  ctx: TrustedContext,
  value: unknown,
  arrival: { via: BlobArrival; runId: string; flowId?: string; prefix?: PathSegment[] },
  report: (error: unknown) => void,
): Promise<BlobRefusal | null> {
  const found = findBlobRefs(value, { limit: MAX_INPUT_BLOB_REFS });
  if (found.length === 0) return null;
  if (found.length > MAX_INPUT_BLOB_REFS) return { status: "invalid", message: `An input may give at most ${MAX_INPUT_BLOB_REFS} files (${BLOB_CODES.tooMany}).` };
  // Fail closed: a reference is checked against the scope or not accepted at all.
  const scope = readScope(ctx?.scope);
  if (scope === null) return { status: "invalid", message: `Invalid trusted context: its scope cannot be read, so no file is accepted (${BLOB_CODES.unvouched}).` };
  const at = (path: PathSegment[]): string => formatPath([...(arrival.prefix ?? []), ...path]);
  for (const { path, value: ref } of found) {
    const problem = checkBlobRef(ref, scope);
    if (problem?.code === "malformed") return { status: "invalid", message: `The file reference at ${at(path)} is not one: ${problem.message} (${BLOB_CODES.invalid}).` };
    if (problem) return { status: "invalid", message: `The file reference at ${at(path)} was made for another workspace, or changed since (${BLOB_CODES.foreign}).` };
  }
  if (!host) return { status: "invalid", message: `This service does not accept files (${BLOB_CODES.unvouched}).` };
  let answers: unknown[];
  try {
    answers = await Promise.all(
      found.map(({ path, value: ref }) =>
        host.vouch({
          scope: { ...scope },
          ref: copyBlobRef(ref as unknown as BlobRef),
          actor: { ...ctx.actor },
          ...(ctx.subject ? { subject: { ...ctx.subject } } : {}),
          via: arrival.via,
          runId: arrival.runId,
          ...(arrival.flowId !== undefined ? { flowId: arrival.flowId } : {}),
          path: at(path),
          requestId: ctx.requestId,
        }),
      ),
    );
  } catch (error) {
    report(error);
    return { status: "unavailable", message: "The files could not be checked right now." };
  }
  const refused = answers.findIndex((answer) => answer !== true);
  if (refused >= 0) return { status: "invalid", message: `The file at ${at(found[refused]!.path)} was not accepted (${BLOB_CODES.unvouched}).` };
  return null;
}

/**
 * Checks the references in a performer's answer against the run's scope. An
 * `ok` outcome naming a malformed reference, or one made for another scope,
 * becomes `final` for a read and `unknown` for a write (it may have happened).
 */
export function guardBlobOutcome(outcome: ActionOutcome, effect: ActionEffectKind, scope: Scope): ActionOutcome {
  if (outcome.status !== "ok" || outcome.output === null) return outcome;
  for (const { path, value } of findBlobRefs(outcome.output)) {
    const problem = checkBlobRef(value, scope);
    if (!problem) continue;
    const error =
      problem.code === "malformed"
        ? { code: BLOB_CODES.invalid, message: "The service answered with a file it could not describe.", detail: `${formatPath(path)}: ${problem.message}` }
        : { code: BLOB_CODES.foreign, message: "The service answered with a file from another workspace.", detail: formatPath(path) };
    return effect === "read" ? { status: "final", error } : { status: "unknown", error };
  }
  return outcome;
}

/**
 * Watches a performer's answer the runtime stopped waiting for at the
 * deadline. Nothing records it, so a file it stored and names is held by no
 * run: each reference in an `ok` output bound to `scope`, other than those
 * the envelope gave it (`given`, which the run holds already), is reported to
 * `report` by id, for the host to delete. The connector kit withholds an
 * answer it knows is late; this covers the time an answer spends between the
 * performer and the runtime. Never throws.
 */
export function reportLateBlobs(answer: Promise<unknown>, scope: Scope, given: unknown, report: (error: unknown) => void): void {
  answer
    .then((late) => {
      if (!isJsonObject(late as JsonValue) || (late as { status?: unknown }).status !== "ok") return;
      const named = heldBlobRefs((late as { output?: unknown }).output, scope);
      for (const id of heldBlobRefs(given, scope).keys()) named.delete(id);
      if (named.size > 0) report(new Error(`an answer that came after its deadline named stored files no run holds: ${[...named.keys()].join(", ")}`));
    })
    .catch(() => undefined);
}

/** True for an object shaped like a `FlowView`: the run its references belong to. */
function viewRunId(o: Record<string, unknown>): string | null {
  return typeof o.runId === "string" && typeof o.flowId === "string" && typeof o.revision === "number" && Array.isArray(o.known) ? o.runId : null;
}

/** A URL a view may carry: `https`, at most {@link MAX_BLOB_URL_LENGTH} characters. */
export function isViewUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_BLOB_URL_LENGTH) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Gives every reference in a response the `url` the host resolves for this
 * viewer (null when it resolves none, when it is not an `https` URL of at
 * most 2048 characters, or for a reference not bound to `ctx.scope`, which
 * the host is never asked about). Each reference is resolved once per run
 * per response. Copy-on-write; `value` itself when it holds no reference.
 */
export async function resolveBlobUrls<T>(value: T, ctx: TrustedContext, host: BlobHost | undefined, report: (error: unknown) => void): Promise<T> {
  if (!hasBlobRefs(value)) return value;
  // A scope that cannot be read gets no URL for anything: the host is never asked.
  const scope = readScope(ctx?.scope);
  const top = isJsonObject(value as JsonValue) && typeof (value as Record<string, unknown>).runId === "string" ? ((value as Record<string, unknown>).runId as string) : null;
  const jobs = new Map<string, Promise<string | null>>();
  const urls = new Map<object, Promise<string | null>>();
  const ask = (ref: BlobRef, runId: string | null, scope: Scope): Promise<string | null> => {
    const key = `${runId ?? ""}\n${ref.binding}`;
    let job = jobs.get(key);
    if (!job) {
      const resolve = host?.resolveBlobUrl;
      job = !resolve
        ? Promise.resolve(null)
        : Promise.resolve()
            .then(() => resolve.call(host, { ...scope }, copyBlobRef(ref), { runId, viewer: { ...ctx.actor }, requestId: ctx.requestId }))
            .then(
              (url) => {
                if (url === null || url === undefined) return null;
                if (isViewUrl(url)) return url;
                report(new Error(`resolveBlobUrl answered something that is not an https URL of at most ${MAX_BLOB_URL_LENGTH} characters`));
                return null;
              },
              (error: unknown) => {
                report(error);
                return null;
              },
            );
      jobs.set(key, job);
    }
    return job;
  };
  const collect = (v: unknown, runId: string | null, depth: number): void => {
    if (depth > 64 || typeof v !== "object" || v === null) return;
    if (Array.isArray(v)) {
      for (const item of v) collect(item, runId, depth + 1);
      return;
    }
    if (isBlobRefLike(v)) {
      urls.set(v, scope === null || checkBlobRef(v, scope) !== null ? Promise.resolve(null) : ask(v as unknown as BlobRef, runId, scope));
      return;
    }
    const o = v as Record<string, unknown>;
    const here = viewRunId(o) ?? runId;
    for (const key of Object.keys(o)) collect(o[key], here, depth + 1);
  };
  collect(value, top, 0);
  const settled = new Map<object, string | null>();
  await Promise.all([...urls].map(async ([ref, url]) => settled.set(ref, await url)));
  const rewrite = (v: unknown, depth: number): unknown => {
    if (depth > 64 || typeof v !== "object" || v === null) return v;
    if (Array.isArray(v)) {
      let out: unknown[] | null = null;
      v.forEach((item, i) => {
        const next = rewrite(item, depth + 1);
        if (next !== item) (out ??= v.slice())[i] = next;
      });
      return out ?? v;
    }
    const o = v as Record<string, unknown>;
    if (settled.has(o)) {
      // Malformed ones are left as they are: they are not references a viewer can open.
      if (checkBlobRef(o) !== null) return v;
      return { ...copyBlobRef(o as unknown as BlobRef), url: settled.get(o) ?? null };
    }
    let out: Record<string, unknown> | null = null;
    for (const key of Object.keys(o)) {
      const next = rewrite(o[key], depth + 1);
      if (next !== o[key]) {
        out ??= { ...o };
        Object.defineProperty(out, key, { value: next, enumerable: true, writable: true, configurable: true });
      }
    }
    return out ?? v;
  };
  return rewrite(value, 0) as T;
}

/** The references in `value` bound to `scope`, unique by id, in the order found. */
export function heldBlobRefs(value: unknown, scope: Scope, into: Map<string, BlobRef> = new Map()): Map<string, BlobRef> {
  for (const { value: ref } of findBlobRefs(value)) {
    if (checkBlobRef(ref, scope) !== null) continue;
    const id = (ref as unknown as BlobRef).id;
    if (!into.has(id)) into.set(id, copyBlobRef(ref as unknown as BlobRef));
  }
  return into;
}
