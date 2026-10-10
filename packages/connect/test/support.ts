import type pg from "pg";
import { defineConnector, type Connector } from "@aaply/connector-sdk";
import { mockFetch, type MockFetch } from "@aaply/connector-sdk/testing";
import type { ActionOutcome, ActionPort, ActionPortDescription, ApprovedAction } from "@aaply/action-contract";

export const API = "https://api.notes.test/v1";

/** A notes service: a read, a write that does not de-duplicate (with an undo), and its undo. `tag` marks which version answered. */
export function notesConnector(version: string, tag: string, extra: { slowMs?: number } = {}): Connector {
  return defineConnector({
    id: "notes",
    version,
    title: "Notes",
    auth: { kind: "apiKey" },
    egress: ["GET api.notes.test/v1/*", "POST api.notes.test/v1/*", "DELETE api.notes.test/v1/*"],
    operations: {
      get: {
        title: "Get a note",
        effect: "read",
        input: { type: "object", properties: { id: { type: "string" } } },
        output: { type: "object" },
        handler: async (input, ctx) => {
          if (extra.slowMs) await new Promise((resolve, reject) => {
            const t = setTimeout(resolve, extra.slowMs);
            ctx.signal.addEventListener("abort", () => (clearTimeout(t), reject(ctx.signal.reason)));
          });
          const body = (await (await ctx.http({ url: `${API}/notes/${String(input.id ?? "n1")}` })).ensureOk().json()) as object;
          return { ...body, tag };
        },
      },
      create: {
        title: "Create a note",
        effect: "write",
        input: { type: "object", properties: { title: { type: "string" } } },
        // The tag in the output schema makes each version's contract differ, so pins route.
        output: { type: "object", properties: { tag: { type: "string", enum: [tag] } } },
        compensate: "remove",
        handler: async (input, ctx) => ({ ...((await (await ctx.http({ method: "POST", url: `${API}/notes`, json: input })).ensureOk().json()) as object), tag }),
      },
      remove: {
        title: "Remove a note",
        effect: "write",
        idempotent: true,
        input: { type: "object" },
        output: { type: "object" },
        handler: async (_input, ctx) => (await ctx.http({ method: "DELETE", url: `${API}/notes/n1` })).ensureOk().json(),
      },
    },
  });
}

export function notesService(): MockFetch {
  return mockFetch({
    [`GET ${API}/notes/*`]: { json: { id: "n1", title: "Hello" } },
    [`POST ${API}/notes`]: { json: { id: "n1" } },
    [`DELETE ${API}/notes/*`]: { json: {} },
  });
}

/** An action port that sends envelopes to Connect over HTTP, as the engine's host does. */
export function httpPort(base: string, token?: string): ActionPort & { describe(): Promise<ActionPortDescription> } {
  const headers = { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) };
  return {
    async run(approved: ApprovedAction, signal?: AbortSignal): Promise<ActionOutcome> {
      const res = await fetch(`${base}/perform`, { method: "POST", headers, body: JSON.stringify(approved), ...(signal ? { signal } : {}) });
      if (res.status !== 200) throw new Error(`/perform answered ${res.status}`);
      return (await res.json()) as ActionOutcome;
    },
    async describe() {
      return (await (await fetch(`${base}/describe`)).json()) as ActionPortDescription;
    },
  };
}

/** Wraps a pool to count the statements and checkouts the service makes. */
export function countingPool(pool: pg.Pool): { pool: pg.Pool; count(): number; reset(): void } {
  let n = 0;
  const proxy = new Proxy(pool, {
    get(target, key, receiver) {
      if (key === "query") return (...args: unknown[]) => (n++, (target.query as (...a: unknown[]) => unknown)(...args));
      if (key === "connect") return async () => {
        const client = await target.connect();
        return new Proxy(client, {
          get(c, k, r) {
            if (k === "query") return (...args: unknown[]) => (n++, (c.query as (...a: unknown[]) => unknown).apply(c, args));
            const v = Reflect.get(c, k, r);
            return typeof v === "function" ? v.bind(c) : v;
          },
        });
      };
      const v = Reflect.get(target, key, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return { pool: proxy, count: () => n, reset: () => (n = 0) };
}
