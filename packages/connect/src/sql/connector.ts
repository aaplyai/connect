/**
 * A declared SQL connector as a kit connector: each operation's handler runs
 * its statement through the executor. The kit's port then makes every check
 * it makes for code connectors (effect, undo pairing, an undo-only operation
 * sent as a step, risk floor, input and output schemas, the connection, its
 * environment, the replay claim), and
 * the operation contract carries the statement's digest as its
 * `implementation`, so a pin covers the SQL.
 */

import { ConnectorError, defineConnector, type Connector, type OperationDefinition } from "@aaply/connector-sdk";
import { implementationDigest, type SqlConnectorDefinition } from "./definition.js";
import type { SqlExecutor, SqlTarget } from "./executor.js";

/** What a SQL handler needs from the call in progress: the connection, its password, the caller's own deadline and its commit hook. */
export type SqlConnectionContext = () => Promise<{ tenantId: string; poolKey: string; target: SqlTarget; password: string; deadline: number; onCommit(): void; onRolledBack(): void }>;

export function sqlConnector(definition: SqlConnectorDefinition, executor: SqlExecutor, connection: SqlConnectionContext): Connector {
  const operations: Record<string, OperationDefinition> = {};
  for (const [name, op] of Object.entries(definition.operations)) {
    const implementation = implementationDigest(definition.engine, op);
    operations[name] = {
      title: op.title,
      ...(op.description !== undefined ? { description: op.description } : {}),
      effect: op.effect,
      input: op.input,
      output: op.output,
      ...(op.idempotent !== undefined ? { idempotent: op.idempotent } : {}),
      ...(op.compensate !== undefined ? { compensate: op.compensate } : {}),
      ...(op.undoOnly !== undefined ? { undoOnly: op.undoOnly } : {}),
      ...(op.irreversible !== undefined ? { irreversible: op.irreversible } : {}),
      ...(op.riskFloor !== undefined ? { riskFloor: op.riskFloor } : {}),
      implementation,
      handler: async (input, ctx) => {
        const c = await connection();
        const out = await executor.run({ ...c, op, input, signal: ctx.signal, deadline: Math.min(ctx.deadline, c.deadline), now: Date.now() });
        if (out === undefined) throw new ConnectorError("final", "sql/no-row", "Nothing matched.");
        return out as never;
      },
    };
  }
  return defineConnector({ id: definition.id, version: definition.version, title: definition.title, auth: { kind: "none" }, egress: [], operations });
}
