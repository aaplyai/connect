/**
 * `@aaply/connect/http`: Connect over HTTP, on `node:http`.
 *
 * - `POST /perform` takes an approved action as JSON and always answers 200
 *   with an `ActionOutcome`: the engine records any other answer to a write
 *   as "unknown". A body that is too large or not JSON is refused as an
 *   invalid envelope (final), with 200.
 * - `GET /oauth/start` and `GET /oauth/callback` are the person's browser
 *   connecting an account (`ConnectOptions.oauth`): redirects, and short
 *   plain-text pages for a link that expired or was used.
 * - `GET /describe` answers the contract versions served.
 * - `POST /admin/<operation>` is the admin API, each request signed by the
 *   Aaply backend (see admin-http.ts and `createAdminClient`).
 * - `GET /health` answers while the process runs; `GET /ready` while the
 *   store answers too (503 otherwise). A pool busy with calls is ready, and
 *   one answer stands for 5 s (`Connect.ready`).
 *
 * The engine's transport must be authenticated: give `performToken` and
 * configure the engine's host to send `authorization: Bearer <token>`
 * (`HttpActionPortOptions.headers`), or put mTLS in front. A request without
 * it gets 401, before anything is read.
 *
 * `serveConnect` adds graceful shutdown: it stops taking requests and lets
 * calls in flight finish, up to `drainMs`, because an unanswered write is
 * what makes the engine reconcile.
 */

import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { refuse } from "@aaply/action-contract";
import type { Connect } from "./connect.js";
import { CONNECT_VERSION } from "./version.js";

export { createAdminClient, type AdminClientOptions } from "./admin-http.js";

export interface ConnectHttpOptions {
  /** The bearer token the engine's host sends (at least 32 characters). Required unless `noPerformToken` says otherwise. */
  performToken?: string;
  /** Leave /perform open to whoever can reach it: only behind mTLS or on a private link. Default false. */
  noPerformToken?: boolean;
  /** Largest request body, in bytes. Default 2 MiB. */
  maxBodyBytes?: number;
}

export type ConnectHandler = (req: IncomingMessage, res: ServerResponse) => void;

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), "cache-control": "no-store" });
  res.end(text);
}

function readBody(req: IncomingMessage, max: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > max) {
      req.resume();
      resolve(null);
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > max) {
        chunks.length = 0;
        req.removeAllListeners("data");
        req.resume();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(size > max ? null : Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function bearerMatches(header: string | undefined, token: string): boolean {
  const m = /^Bearer (.+)$/.exec(header ?? "");
  if (!m) return false;
  const a = Buffer.from(m[1]!, "utf8");
  const b = Buffer.from(token, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createConnectHandler(connect: Connect, options: ConnectHttpOptions = {}): ConnectHandler {
  const max = options.maxBodyBytes ?? 2 * 1024 * 1024;
  if (options.performToken === undefined && options.noPerformToken !== true) throw new Error("performToken is required (or set noPerformToken behind mTLS)");
  if (options.performToken !== undefined && options.performToken.length < 32) throw new Error("performToken must be at least 32 characters");
  return (req, res) => {
    void (async () => {
      const path = (req.url ?? "/").split("?")[0] ?? "/";
      if (path === "/perform") {
        if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
        if (options.performToken !== undefined && !bearerMatches(req.headers.authorization, options.performToken)) return send(res, 401, { error: "unauthorized" });
        const body = await readBody(req, max);
        if (body === null) return send(res, 200, refuse("connect/invalid-envelope", "The request was too large.", { detail: `over ${max} bytes` }));
        let value: unknown;
        try {
          value = JSON.parse(body.toString("utf8"));
        } catch {
          return send(res, 200, refuse("connect/invalid-envelope", "The request was not JSON."));
        }
        // The engine gave up (it closed the request): stop the call too.
        const gone = new AbortController();
        res.on("close", () => {
          if (!res.writableFinished) gone.abort();
        });
        return send(res, 200, await connect.perform(value, gone.signal));
      }
      if (path.startsWith("/admin/")) {
        // A SQL definition is at most 256 KiB of JSON; nothing an admin sends needs more than twice that.
        const body = await readBody(req, Math.min(max, 512 * 1024));
        if (body === null) return send(res, 413, { error: { code: "admin/invalid", message: "the request was too large" } });
        const answer = await connect.adminRequest({ method: req.method ?? "", path, headers: req.headers, body: body.toString("utf8") });
        return send(res, answer.status, answer.body);
      }
      if (req.method !== "GET") return send(res, 405, { error: "method not allowed" });
      if (path === "/oauth/start" || path === "/oauth/callback") {
        const answer = await connect.oauthRequest({ path, query: new URL(req.url ?? "/", "http://connect").searchParams, cookie: req.headers.cookie });
        // Nothing of this page is cached or framed, and the code in its URL is never sent on as a referrer.
        const headers: Record<string, string | string[]> = { "cache-control": "no-store", "referrer-policy": "no-referrer", "x-frame-options": "DENY", "content-security-policy": "default-src 'none'; frame-ancestors 'none'" };
        if (answer.setCookie) headers["set-cookie"] = answer.setCookie;
        if ("redirect" in answer) {
          res.writeHead(302, { ...headers, location: answer.redirect, "content-length": 0 });
          return res.end();
        }
        res.writeHead(answer.status, { ...headers, "content-type": "text/plain; charset=utf-8", "content-length": Buffer.byteLength(answer.text) });
        return res.end(answer.text);
      }
      if (path === "/describe") return send(res, 200, connect.describe());
      if (path === "/health") return send(res, 200, { status: "ok", version: CONNECT_VERSION });
      if (path === "/ready") return (await connect.ready()) ? send(res, 200, { status: "ready" }) : send(res, 503, { status: "unavailable" });
      return send(res, 404, { error: "not found" });
    })().catch(() => {
      if (!res.headersSent) send(res, 500, { error: "internal" });
      else res.destroy();
    });
  };
}

export interface ServedConnect {
  server: Server;
  /** Stops taking requests, waits for calls in flight up to `drainMs`, then closes. */
  close(): Promise<void>;
}

/** Serves Connect on `port` (0 for any), with graceful shutdown. */
export async function serveConnect(connect: Connect, options: ConnectHttpOptions & { port: number; host?: string; drainMs?: number }): Promise<ServedConnect> {
  const handler = createConnectHandler(connect, options);
  let inFlight = 0;
  let drained: (() => void) | null = null;
  const server = createServer((req, res) => {
    inFlight++;
    res.on("close", () => {
      inFlight--;
      if (inFlight === 0) drained?.();
    });
    handler(req, res);
  });
  server.requestTimeout = 120_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host ?? "127.0.0.1", () => resolve());
  });
  return {
    server,
    async close() {
      const stopped = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeIdleConnections();
      if (inFlight > 0) {
        await Promise.race([new Promise<void>((resolve) => (drained = resolve)), new Promise((resolve) => setTimeout(resolve, options.drainMs ?? 60_000).unref())]);
      }
      server.closeAllConnections();
      await stopped;
    },
  };
}
