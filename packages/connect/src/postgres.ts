/**
 * `@aaply/connect/postgres`: Connect's database. `migrate` creates the
 * schema and the `aaply_connect_app` role as the database owner; the
 * service then logs in as a role that is only a member of that one, and
 * `createConnect` refuses any other (`ConnectStore.check`).
 */

export { migrate } from "./store/migrate.js";
export { APP_ROLE, SCHEMA_VERSION } from "./store/schema.js";
export { createPgStore, StoreConflict, type ConnectStore, type Installation, type Resolution } from "./store/store.js";
