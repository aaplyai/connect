/**
 * @aaply/connect: the side of Aaply that holds credentials and performs the
 * actions the Flow Engine approves.
 *
 * - `createConnect` builds the service from deployment config: the engine's
 *   Ed25519 public keys, the code connectors of this build, a PostgreSQL
 *   pool, a `KeyProvider` for the vault, and the operator's egress allowlist.
 *   Its `perform` takes an approved action and never throws; `admin` installs
 *   connectors, sets policy and keeps connections (the operator's), and
 *   `adminAs(person)` does the same within that person's permission. Every
 *   change is in the admin log.
 * - Declared SQL connectors are data (`SqlConnectorDefinition`), installed per
 *   scope with `admin.installSql` and checked by `sqlDefinitionProblems`.
 * - `localKeyProvider` wraps tenants' data keys with one local key.
 * - `egressPolicy` is the network check under every socket Connect opens.
 *
 * The store is in `@aaply/connect/postgres`, the HTTP routes in
 * `@aaply/connect/http`, test helpers in `@aaply/connect/testing`.
 */

export {
  createConnect,
  type Connect,
  type ConnectAdmin,
  type ConnectionOwner,
  type ConnectOptions,
  type NewConnectionInput,
} from "./connect.js";
export { ADMIN_ROLE, AdminError, type ActorAdmin, type AdminActor, type AdminErrorCode } from "./admin.js";
export type { AdminAnswer, AdminRequest } from "./admin-http.js";
export type { TokenRefresher } from "./credentials.js";
export { egressPolicy, type EgressOptions, type EgressPolicy } from "./egress.js";
export { DEFAULT_ROLE } from "./performer.js";
export { sqlDefinitionProblems, type SqlConnectorDefinition, type SqlOperation, type SqlRows, type SqlStatement } from "./sql/definition.js";
export type { SqlTarget } from "./sql/executor.js";
export type { AdminLogEntry, Connection, ConnectionStatus } from "./store/store.js";
export { localKeyProvider, type KeyProvider } from "./vault.js";
export { CONNECT_VERSION } from "./version.js";
