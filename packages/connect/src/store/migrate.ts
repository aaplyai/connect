import type pg from "pg";
import { SCHEMA_SQL } from "./schema.js";

/**
 * Creates Connect's schema, its functions and the `aaply_connect_app` role,
 * as the database owner. Run once on an empty database; a database that
 * already has the schema is left alone (and `check` refuses another build's).
 */
export async function migrate(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('aaply_connect.migrate'))");
    const { rows } = await client.query("SELECT 1 FROM pg_namespace WHERE nspname = 'aaply_connect'");
    if (rows.length === 0) await client.query(SCHEMA_SQL);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
