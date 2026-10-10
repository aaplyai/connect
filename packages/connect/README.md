# @aaply/connect

The service that performs the actions the Flow Engine approves. The engine
signs each approved action with its Ed25519 key; Connect checks it again,
finds the right account, and runs the operation through the connector kit.
The engine never holds a credential.

```ts
import pg from "pg";
import { createConnect, localKeyProvider } from "@aaply/connect";
import { serveConnect } from "@aaply/connect/http";

const connect = await createConnect({
  audience: "connect.aaply.internal",
  engineKeys: { "engine-2026-10": process.env.ENGINE_PUBLIC_KEY! }, // the engine's public key, base64url
  connectors: [gmail],                                               // imported modules of this build only
  pool: new pg.Pool({ connectionString: process.env.CONNECT_DATABASE_URL }),
  keys: localKeyProvider({ keyId: "local-1", key: Buffer.from(process.env.CONNECT_WRAPPING_KEY!, "base64") }),
  egress: { allowPrivate: ["db.internal.aaply.ai"] },                // operator config, never tenant data
});
await serveConnect(connect, { port: 8080, host: "0.0.0.0", performToken: process.env.CONNECT_PERFORM_TOKEN });
```

## What a call goes through

1. `POST /perform` (always 200 with an outcome; 401 without the transport token).
2. The contract's checks and the engine's Ed25519 proof, before the store is touched. HMAC proofs are refused.
3. One store round trip (`aaply_connect.resolve`): the global and per-app kill switches, denied actions,
   the installation, the connection and its sealed secret.
4. The kit port for the connector version the flow pinned (the newest whose operation digest matches;
   else the newest, which refuses with `connect/contract-mismatch`), with the connection's credential
   added only to requests to the connector's declared hosts.
5. A write that does not de-duplicate is claimed once in the store just before it is sent, so the same
   envelope reaching two instances is performed once.

Each call is cut off 2 s before its deadline and at 55 s, and `serveConnect` lets calls in flight finish
when it shuts down.

## The database

`migrate(ownerPool)` (from `@aaply/connect/postgres`) creates the `aaply_connect` schema and the
`aaply_connect_app` role. Connect itself logs in as a role that is only a member of that one:

```sql
CREATE ROLE connect_app LOGIN PASSWORD '...' IN ROLE aaply_connect_app;
```

Every tenant's rows sit behind forced row-level security. `createConnect` refuses to start as a
superuser, a role that can bypass row security, or the schema's owner, and refuses a database made by
another build (pre-1.0 builds do not migrate). Run `connect.purgeExpired()` from a timer to delete
expired replay claims.

## Secrets

Each connection's secret is sealed with AES-256-GCM under its tenant's data key, bound to the tenant,
connection and secret version; data keys are wrapped by the `KeyProvider`. Revoking a connection deletes
its secret. Deleted rows can live on in database backups until those age out.

An API key connection's secret is its headers, `{ "header:authorization": "Bearer …" }`; an OAuth
connection's holds `accessToken`.

## Egress

Every socket Connect opens is checked where it connects: loopback, private, link-local, metadata, CGNAT,
multicast, reserved and tunnelling IPv6 ranges are refused unless the operator's `allowPrivate` names the
CIDR or host. A refused request counts as never sent.
