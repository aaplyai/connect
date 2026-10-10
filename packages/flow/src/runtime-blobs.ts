/**
 * File references at the runtime's public methods (ADR-0008 §4). The runtime
 * is wrapped in a proxy that, around the methods that take or show values:
 *
 * - removes the `url` a view gave each reference in a caller's input
 *   (`start`, `submit`, `deliver`, `resolveEffect`), refusing an input it
 *   cannot read rather than passing it on unchecked;
 * - gives each reference in a response the `url` the host resolves for this
 *   viewer (the methods that answer views);
 * - lists the references a person's export holds (`exportSubject`).
 *
 * The vouch itself ({@link inputVouch}) runs inside the runtime, after the
 * request's own checks (its context, ids and input), its admission and, for
 * an existing run, the caller's access to it, so a request the runtime
 * refuses never costs the host a lookup.
 *
 * Every other method, including one added later, passes through unchanged,
 * bound to the runtime, so the runtime's calls to its own methods never pass
 * through here.
 */

import { hasBlobRefs, type JsonValue } from "@aaply/action-contract";
import { BLOB_CODES, heldBlobRefs, readScope, resolveBlobUrls, stripBlobUrls, vouchBlobRefs, type BlobArrival, type BlobHost } from "./blob-guard.js";
import type { Observer, TrustedContext } from "./ports.js";
import { FlowError, type FlowRuntime, type SubjectExport } from "./runtime.js";

/** Methods whose answer shows views, so their references get URLs. */
const SHOWS_VIEWS = new Set<string>(["start", "submit", "view", "workspace", "turn", "consent", "choose", "resume", "resolveEffect", "migrate"]);

type Method = (...args: unknown[]) => Promise<unknown>;

/** Methods that take values from a caller, and the argument that holds them. */
const TAKES: Readonly<Record<string, number>> = { start: 1, submit: 2, deliver: 1, resolveEffect: 2 };

/** Options of {@link withBlobs}. */
export interface WithBlobsOptions {
  blobs?: BlobHost;
  observer?: Observer;
}

/**
 * The runtime as callers see it: `runtime` behind the checks above. Called
 * by `createFlowRuntime`; a host never needs it.
 */
export function withBlobs(runtime: FlowRuntime, options: WithBlobsOptions): FlowRuntime {
  const host = options.blobs;
  const report = (where: string) => (error: unknown) => options.observer?.error?.(error, where);
  const wrapped = new Map<PropertyKey, unknown>();

  const wrap = (name: string, method: Method): Method => {
    const takes = TAKES[name];
    const shows = SHOWS_VIEWS.has(name);
    return async (...args: unknown[]) => {
      const ctx = args[0] as TrustedContext;
      if (takes !== undefined && hasBlobRefs(args[takes])) {
        let input: unknown;
        try {
          input = stripBlobUrls(args[takes]);
        } catch {
          // Fail closed: an input holding files that cannot be read is never passed on unchecked.
          throw new FlowError("invalid", `Input must be plain JSON, and this one holds a file that cannot be read (${BLOB_CODES.invalid}).`);
        }
        args = args.slice();
        args[takes] = input;
      }
      const result = await method.apply(runtime, args);
      if (shows) return resolveBlobUrls(result, ctx, host, report("blob-url"));
      if (name === "exportSubject") return withExportedBlobs(result as SubjectExport, ctx);
      return result;
    };
  };

  return new Proxy(runtime, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if (typeof value !== "function") return value;
      let fn = wrapped.get(prop);
      if (fn === undefined) {
        fn = typeof prop === "string" && (TAKES[prop] !== undefined || SHOWS_VIEWS.has(prop) || prop === "exportSubject") ? wrap(prop, value as Method) : (value as (...a: unknown[]) => unknown).bind(target);
        wrapped.set(prop, fn);
      }
      return fn;
    },
  });
}

/**
 * Vouches for the references in a caller's input, or throws the refusal as a
 * `FlowError`: what the runtime calls after a request's own checks and its
 * admission, before anything is applied. `authorize`, when given, checks the
 * caller's access to the run and throws its refusal; it runs first, and only
 * when the input holds references (the request is authorized again where it
 * is applied).
 */
export type InputVouch = (ctx: TrustedContext, input: unknown, arrival: { via: BlobArrival; runId: string; flowId?: string }, authorize?: () => Promise<unknown>) => Promise<void>;

/** The runtime's {@link InputVouch}, over the host's `BlobHost` (none refuses every reference). */
export function inputVouch(host: BlobHost | undefined, observer: Observer): InputVouch {
  return async (ctx, input, arrival, authorize) => {
    if (!hasBlobRefs(input)) return;
    await authorize?.();
    const refused = await vouchBlobRefs(host, ctx, input, arrival, (error) => observer.error?.(error, "blob-vouch"));
    if (refused) throw new FlowError(refused.status, refused.message);
  };
}

/** An export with the references it holds listed as `blobs` (absent when it holds none). */
function withExportedBlobs(exported: SubjectExport, ctx: TrustedContext): SubjectExport {
  const scope = readScope(ctx?.scope);
  // The runtime accepted this context, so its scope was readable: one that no longer is fails closed rather than list nothing.
  if (scope === null) throw new FlowError("invalid", "Invalid trusted context.");
  const held = heldBlobRefs({ runs: exported.runs, workspaces: exported.workspaces } as unknown as JsonValue, scope);
  return held.size > 0 ? { ...exported, blobs: [...held.values()] } : exported;
}
