/**
 * A {@link BlobHost} for tests: it vouches for the references it issued, in
 * the scope it issued them in (to the actor it issued them to, when given),
 * and resolves each to a URL that names the reference and the viewer.
 */

import { blobDigestSync, makeBlobRef, type BlobRef } from "@aaply/action-contract";
import type { BlobHost, BlobUrlContext, BlobVouchRequest } from "../blob-guard.js";
import type { Scope } from "../state.js";
import { scopeKey } from "../store.js";

/** What {@link memoryBlobHost} lets a test do and see. */
export interface MemoryBlobHost extends BlobHost {
  /**
   * A reference to `content` the host vouches for in `scope`: for anyone
   * there, or only for the actor `owner` (an actor id) when given.
   */
  issue(scope: Scope, content?: { text?: string; mediaType?: string; name?: string; owner?: string }): BlobRef;
  /** Every vouch the runtime asked for, in order. */
  readonly vouched: BlobVouchRequest[];
  /** Every URL the runtime asked for, in order. */
  readonly resolved: Array<{ scope: Scope; ref: BlobRef; context: BlobUrlContext }>;
}

/** Options of {@link memoryBlobHost}. */
export interface MemoryBlobHostOptions {
  /** Answers URLs; default `https://files.test/<scope>/<id>?viewer=<actor id>`. Null resolves none. */
  url?: ((scope: Scope, ref: BlobRef, context: BlobUrlContext) => string | null | Promise<string | null>) | null;
  /** Answers vouches instead of the issued list (it may throw). */
  vouch?: (request: BlobVouchRequest) => boolean | Promise<boolean>;
}

/** A {@link MemoryBlobHost}. */
export function memoryBlobHost(options: MemoryBlobHostOptions = {}): MemoryBlobHost {
  const issued = new Map<string, { owner: string | null }>();
  const vouched: BlobVouchRequest[] = [];
  const resolved: MemoryBlobHost["resolved"] = [];
  let counter = 0;
  const key = (scope: Scope, ref: BlobRef) => `${scopeKey(scope)}\n${ref.binding}`;
  const url = options.url === undefined ? (scope: Scope, ref: BlobRef, context: BlobUrlContext) => `https://files.test/${encodeURIComponent(scope.tenantId)}/${encodeURIComponent(ref.id)}?viewer=${encodeURIComponent(context.viewer.id)}` : options.url;
  const host: MemoryBlobHost = {
    issue(scope, content = {}) {
      const bytes = new TextEncoder().encode(content.text ?? `file ${counter + 1}`);
      const ref = makeBlobRef(scope, {
        id: `upload-${String(++counter).padStart(4, "0")}`,
        digest: blobDigestSync(bytes),
        size: bytes.length,
        mediaType: content.mediaType ?? "application/pdf",
        ...(content.name !== undefined ? { name: content.name } : {}),
      });
      issued.set(key(scope, ref), { owner: content.owner ?? null });
      return ref;
    },
    vouched,
    resolved,
    vouch(request) {
      vouched.push(structuredClone(request));
      if (options.vouch) return options.vouch(request);
      const found = issued.get(key(request.scope, request.ref));
      return found !== undefined && (found.owner === null || found.owner === request.actor.id);
    },
  };
  if (url) {
    host.resolveBlobUrl = (scope, ref, context) => {
      resolved.push({ scope: { ...scope }, ref: structuredClone(ref), context: structuredClone(context) });
      return url(scope, ref, context);
    };
  }
  return host;
}
