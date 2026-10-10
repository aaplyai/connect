/**
 * Who may change what. The Aaply backend signs each admin request and names
 * the person acting with their roles in the tenant; Connect decides the
 * permission itself:
 *
 * - Installing connectors, policy, the business's own connections and the
 *   admin log need the tenant's `connect-admin` role.
 * - A person creates only their own connections (never someone else's, an
 *   admin included: a person's account is theirs to connect), and sees,
 *   changes and removes only their own; an admin may see and remove any.
 *
 * Every change is written to the admin log in its own transaction.
 */

import type { JsonObject, Scope } from "@aaply/action-contract";
import type { ConnectAdmin } from "./connect.js";
import type { AdminLogEntry, ConnectStore, Connection } from "./store/store.js";

/** The role in a tenant that may administer Connect for it. */
export const ADMIN_ROLE = "connect-admin";

/** The person acting, as the Aaply backend signed it. */
export interface AdminActor {
  domain: string;
  id: string;
  /** Their roles in the tenant the request is for. */
  roles: readonly string[];
}

export type AdminErrorCode = "admin/invalid" | "admin/forbidden" | "admin/not-found" | "admin/conflict";

/** A refused admin request; `code` says how (HTTP answers 400, 403, 404 or 409). */
export class AdminError extends Error {
  override readonly name = "AdminError";
  constructor(
    readonly code: AdminErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** What a person may do as admin: the operator's `ConnectAdmin`, less the global switch, plus the log. */
export type ActorAdmin = Omit<ConnectAdmin, "setGlobalDisabled"> & {
  log(tenantId: string, page?: { limit?: number; before?: string }): Promise<AdminLogEntry[]>;
};

const personOf = (actor: AdminActor) => `${actor.domain}:${actor.id}`;

/** Checks an actor's shape: the backend's signature vouches for it, not for its form. */
export function adminActorProblem(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return "actor is { domain, id, roles }";
  const a = value as Record<string, unknown>;
  if (typeof a.domain !== "string" || !/^[^:\s]{1,64}$/.test(a.domain)) return "actor.domain is 1-64 characters, no ':' or spaces";
  if (typeof a.id !== "string" || !/^\S{1,256}$/.test(a.id)) return "actor.id is 1-256 characters, no spaces";
  if (!Array.isArray(a.roles) || a.roles.length > 64 || !a.roles.every((r) => typeof r === "string" && r.length > 0 && r.length <= 128)) return "actor.roles is a list of role names";
  return null;
}

/**
 * `raw` with each change written to the admin log as `who`'s, in the
 * change's own transaction.
 */
export function loggedAdmin(raw: ConnectAdmin, store: ConnectStore, who: JsonObject): ConnectAdmin {
  const audited = <T>(action: string, target: string | null, detail: JsonObject, work: () => Promise<T>) => store.audited({ actor: who, action, target, detail }, work);
  const scopeDetail = (scope: Scope): JsonObject => ({ appId: scope.appId, environmentId: scope.environmentId });
  return {
    install: (scope, connectorId) => audited("install", connectorId, scopeDetail(scope), () => raw.install(scope, connectorId)),
    installSql: (scope, definition) => audited("installSql", definition.id, { ...scopeDetail(scope), version: definition.version }, () => raw.installSql(scope, definition)),
    uninstall: (scope, connectorId) => audited("uninstall", connectorId, scopeDetail(scope), () => raw.uninstall(scope, connectorId)),
    setPolicy: (scope, change) =>
      audited("setPolicy", null, { ...scopeDetail(scope), ...(change.disabled !== undefined ? { disabled: change.disabled } : {}), ...(change.denied ? { denied: [...change.denied] } : {}) }, () =>
        raw.setPolicy(scope, change),
      ),
    // The global switch has no tenant, so it has no tenant's log: the deployment's own logs record it.
    setGlobalDisabled: (disabled) => raw.setGlobalDisabled(disabled),
    // The new connection's id becomes the entry's target (the store sets it).
    createConnection: (input) =>
      audited(
        "createConnection",
        null,
        { ...scopeDetail(input.scope), connectorId: input.connectorId, owner: "person" in input.owner ? "person" : "business", environmentKind: input.environmentKind ?? "production", grantedScopes: [...(input.grantedScopes ?? [])] },
        () => raw.createConnection(input),
      ),
    updateConnection: (tenantId, id, expectedVersion, change) => audited("updateConnection", id, { fields: Object.keys(change).sort() }, () => raw.updateConnection(tenantId, id, expectedVersion, change)),
    revokeConnection: (tenantId, id) => audited("revokeConnection", id, {}, () => raw.revokeConnection(tenantId, id)),
    connection: (tenantId, id) => raw.connection(tenantId, id),
    connections: (scope, filter) => raw.connections(scope, filter),
    operations: (scope) => raw.operations(scope),
  };
}

/**
 * The admin API as `actor`: every call checked against their permission,
 * every change logged as theirs. `raw` is the unchecked, unlogged API.
 */
export function adminAs(raw: ConnectAdmin, store: ConnectStore, actor: AdminActor): ActorAdmin {
  const isAdmin = actor.roles.includes(ADMIN_ROLE);
  const admin = loggedAdmin(raw, store, { domain: actor.domain, id: actor.id, roles: [...actor.roles] });
  const requireAdmin = (what: string) => {
    if (!isAdmin) throw new AdminError("admin/forbidden", `${what} needs the ${ADMIN_ROLE} role`);
  };
  /** The connection, if the actor may see it; an admin sees any, a person only their own (others read as missing). */
  const visible = async (tenantId: string, id: string): Promise<Connection> => {
    const c = await raw.connection(tenantId, id);
    if (!c || (!isAdmin && c.ownerSubject !== personOf(actor))) throw new AdminError("admin/not-found", `no connection ${id}`);
    return c;
  };

  return {
    install(scope, connectorId) {
      requireAdmin("installing a connector");
      return admin.install(scope, connectorId);
    },
    installSql(scope, definition) {
      requireAdmin("installing a connector");
      return admin.installSql(scope, definition);
    },
    uninstall(scope, connectorId) {
      requireAdmin("removing a connector");
      return admin.uninstall(scope, connectorId);
    },
    setPolicy(scope, change) {
      requireAdmin("changing policy");
      return admin.setPolicy(scope, change);
    },
    createConnection(input) {
      if ("person" in input.owner) {
        if (input.owner.person !== personOf(actor)) throw new AdminError("admin/forbidden", "a person connects only their own account");
      } else requireAdmin("connecting the business's account");
      return admin.createConnection(input);
    },
    async updateConnection(tenantId, id, expectedVersion, change) {
      const c = await visible(tenantId, id);
      if (c.ownerSubject === null) requireAdmin("changing the business's connection");
      else if (c.ownerSubject !== personOf(actor)) throw new AdminError("admin/forbidden", "only its owner changes a person's connection");
      return admin.updateConnection(tenantId, id, expectedVersion, change);
    },
    async revokeConnection(tenantId, id) {
      const c = await visible(tenantId, id);
      if (c.ownerSubject === null) requireAdmin("removing the business's connection");
      return admin.revokeConnection(tenantId, id);
    },
    async connection(tenantId, id) {
      try {
        return await visible(tenantId, id);
      } catch (error) {
        if (error instanceof AdminError) return null;
        throw error;
      }
    },
    connections(scope, filter = {}) {
      if (isAdmin) return admin.connections(scope, filter);
      if (filter.ownerSubject !== undefined && filter.ownerSubject !== personOf(actor)) throw new AdminError("admin/forbidden", "a person lists only their own connections");
      return admin.connections(scope, { ...filter, ownerSubject: personOf(actor) });
    },
    operations(scope) {
      requireAdmin("reading operation contracts");
      return admin.operations(scope);
    },
    log(tenantId, page) {
      requireAdmin("reading the admin log");
      return store.adminLog(tenantId, page);
    },
  };
}
