/**
 * The admin API over HTTP: `POST /admin/<operation>`, each request signed by
 * the Aaply backend with its Ed25519 key.
 *
 * The signature covers a tag, Connect's audience, the method, the path, the
 * time, a nonce and the body's SHA-256, so a request can't be moved to
 * another Connect, path or body, and is refused once more than a minute old
 * or seen before. The body is read only after the signature verifies. The
 * actor names their tenant, and every operation is held to it. Admin
 * requests carry secrets: serve this hop over TLS (or mTLS). The body names the person acting (`actor`) and the
 * operation's arguments; Connect checks the person's permission itself
 * (admin.ts).
 *
 * `createAdminClient` is the backend's side: it signs and sends.
 */

import { createHash, randomBytes } from "node:crypto";
import type { ApprovedActionSigner, ApprovedActionVerifier } from "@aaply/action-contract";
import { AdminError, adminActorProblem, type ActorAdmin, type AdminActor, type AdminErrorCode } from "./admin.js";
import type { Connect } from "./connect.js";
import { StoreConflict, type ConnectStore } from "./store/store.js";

const TAG = "aaply.connect-admin.1";
/** How far a request's time may be from Connect's clock. */
const WINDOW_MS = 60_000;

const H = { key: "x-aaply-key", sig: "x-aaply-signature", time: "x-aaply-time", nonce: "x-aaply-nonce" } as const;

/** The operations served, by path name. The global kill switch is not among them: it is the operator's. */
const OPERATIONS = ["install", "installSql", "uninstall", "setPolicy", "createConnection", "updateConnection", "revokeConnection", "connection", "connections", "operations", "log", "startOAuth"] as const;
type Operation = (typeof OPERATIONS)[number];

function signingBytes(r: { audience: string; method: string; path: string; time: string; nonce: string; body: string }): Uint8Array {
  const digest = createHash("sha256").update(r.body, "utf8").digest("hex");
  return new TextEncoder().encode(`${TAG}\n${r.audience}\n${r.method}\n${r.path}\n${r.time}\n${r.nonce}\n${digest}`);
}

const STATUS: Record<AdminErrorCode, number> = { "admin/invalid": 400, "admin/forbidden": 403, "admin/not-found": 404, "admin/conflict": 409 };

export interface AdminRequest {
  method: string;
  path: string;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  body: string;
}

export interface AdminAnswer {
  status: number;
  body: unknown;
}

/**
 * Checks a signed admin request and runs it. Answers 401 for a bad or replayed
 * signature, 400/403/404/409 for a refused operation, 200 with
 * `{ result }` otherwise.
 */
export function createAdminRoutes(connect: Connect, options: { audience: string; verifier: ApprovedActionVerifier; store: Pick<ConnectStore, "claim">; now?: () => number }) {
  const now = options.now ?? Date.now;
  const header = (r: AdminRequest, name: string) => {
    const v = r.headers[name];
    return typeof v === "string" ? v : undefined;
  };
  const refused = (code: AdminErrorCode | "admin/unauthenticated", message: string, status = code === "admin/unauthenticated" ? 401 : STATUS[code as AdminErrorCode]): AdminAnswer => ({ status, body: { error: { code, message } } });

  return async function handle(r: AdminRequest): Promise<AdminAnswer> {
    const op = r.path.slice("/admin/".length) as Operation;
    if (!OPERATIONS.includes(op)) return { status: 404, body: { error: { code: "admin/not-found", message: "no such operation" } } };
    if (r.method !== "POST") return { status: 405, body: { error: { code: "admin/invalid", message: "method not allowed" } } };
    const keyId = header(r, H.key);
    const sig = header(r, H.sig);
    const time = header(r, H.time);
    const nonce = header(r, H.nonce);
    if (!keyId || !sig || !time || !nonce || !/^\d{1,16}$/.test(time) || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) return refused("admin/unauthenticated", "the request is not signed");
    if (Math.abs(now() - Number(time)) > WINDOW_MS) return refused("admin/unauthenticated", "the request's time is too far from now");
    // The signature first: nothing of an unsigned body is parsed.
    const bytes = signingBytes({ audience: options.audience, method: r.method, path: r.path, time, nonce, body: r.body });
    let valid = false;
    try {
      valid = await options.verifier.verify(bytes, { alg: "Ed25519", keyId, sig }, { audience: options.audience, scope: { tenantId: "", appId: "", environmentId: "" } });
    } catch {
      valid = false;
    }
    if (!valid) return refused("admin/unauthenticated", "the signature does not verify");
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(r.body);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
      body = parsed as Record<string, unknown>;
    } catch {
      return refused("admin/invalid", "the body is not a JSON object");
    }
    const problem = adminActorProblem(body.actor);
    if (problem) return refused("admin/invalid", problem);
    const actor = body.actor as AdminActor;
    // Once only: the nonce is held well past the window, under the actor's tenant (every operation is held to it).
    if (!(await options.store.claim(actor.tenantId, `admin:${nonce}`, Number(time) + WINDOW_MS))) return refused("admin/unauthenticated", "the request was already used");

    const admin = connect.adminAs(actor);
    try {
      return { status: 200, body: { result: (await run(admin, op, body)) ?? null } };
    } catch (error) {
      if (error instanceof AdminError) return refused(error.code, error.message);
      if (error instanceof StoreConflict) return refused("admin/conflict", error.message);
      throw error;
    }
  };
}

/** One operation with the request's arguments; a missing argument is the operation's own error. */
function run(admin: ActorAdmin, op: Operation, b: Record<string, any>): Promise<unknown> {
  const need = (...names: string[]) => {
    for (const name of names) if (b[name] === undefined) throw new AdminError("admin/invalid", `${op} needs ${name}`);
  };
  switch (op) {
    case "install":
      need("scope", "connectorId");
      return admin.install(b.scope, b.connectorId);
    case "installSql":
      need("scope", "definition");
      return admin.installSql(b.scope, b.definition);
    case "uninstall":
      need("scope", "connectorId");
      return admin.uninstall(b.scope, b.connectorId);
    case "setPolicy":
      need("scope", "change");
      return admin.setPolicy(b.scope, b.change);
    case "createConnection":
      need("input");
      return admin.createConnection(b.input);
    case "updateConnection":
      need("tenantId", "id", "expectedVersion", "change");
      return admin.updateConnection(b.tenantId, b.id, b.expectedVersion, b.change);
    case "revokeConnection":
      need("tenantId", "id");
      return admin.revokeConnection(b.tenantId, b.id);
    case "connection":
      need("tenantId", "id");
      return admin.connection(b.tenantId, b.id);
    case "connections":
      need("scope");
      return admin.connections(b.scope, b.filter ?? {});
    case "operations":
      need("scope");
      return admin.operations(b.scope);
    case "log":
      need("tenantId");
      return admin.log(b.tenantId, b.page ?? {});
    case "startOAuth":
      need("input");
      return admin.startOAuth(b.input);
  }
}

export interface AdminClientOptions {
  /** Connect's base URL. */
  url: string;
  /** Connect's audience, as its `createConnect` was given it. */
  audience: string;
  /** The backend's Ed25519 signer (`ed25519ActionSigner`), whose public key Connect has in `adminKeys`. */
  signer: ApprovedActionSigner;
  fetch?: typeof fetch;
  now?: () => number;
}

/** The Aaply backend's side of the admin API: `client.as(person)` is the admin API as that person, signed and sent. */
export function createAdminClient(options: AdminClientOptions): { as(actor: AdminActor): ActorAdmin } {
  const doFetch = options.fetch ?? fetch;
  const call = async (actor: AdminActor, op: Operation, args: Record<string, unknown>): Promise<any> => {
    const path = `/admin/${op}`;
    const body = JSON.stringify({ actor, ...args });
    const time = String((options.now ?? Date.now)());
    const nonce = randomBytes(18).toString("base64url");
    const proof = await options.signer.sign(signingBytes({ audience: options.audience, method: "POST", path, time, nonce, body }), {
      audience: options.audience,
      scope: { tenantId: actor.tenantId, appId: "", environmentId: "" },
    });
    const res = await doFetch(`${options.url}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", [H.key]: proof.keyId, [H.sig]: proof.sig, [H.time]: time, [H.nonce]: nonce },
      body,
    });
    const answer = (await res.json()) as { result?: unknown; error?: { code: AdminErrorCode; message: string } };
    if (res.status === 200) return answer.result;
    throw new AdminError(answer.error?.code ?? "admin/invalid", answer.error?.message ?? `Connect answered ${res.status}`);
  };
  return {
    as(actor) {
      return {
        install: (scope, connectorId) => call(actor, "install", { scope, connectorId }),
        installSql: (scope, definition) => call(actor, "installSql", { scope, definition }),
        uninstall: (scope, connectorId) => call(actor, "uninstall", { scope, connectorId }),
        setPolicy: (scope, change) => call(actor, "setPolicy", { scope, change }),
        createConnection: (input) => call(actor, "createConnection", { input }),
        updateConnection: (tenantId, id, expectedVersion, change) => call(actor, "updateConnection", { tenantId, id, expectedVersion, change }),
        revokeConnection: (tenantId, id) => call(actor, "revokeConnection", { tenantId, id }),
        connection: (tenantId, id) => call(actor, "connection", { tenantId, id }),
        connections: (scope, filter) => call(actor, "connections", { scope, ...(filter ? { filter } : {}) }),
        operations: (scope) => call(actor, "operations", { scope }),
        log: (tenantId, page) => call(actor, "log", { tenantId, ...(page ? { page } : {}) }),
        startOAuth: (input) => call(actor, "startOAuth", { input }),
      };
    },
  };
}
