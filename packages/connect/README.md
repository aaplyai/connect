# @aaply/connect

The service that performs the actions the Flow Engine approves. The engine
signs each approved action with its Ed25519 key; Connect checks it again,
finds the right account, and runs the operation through the connector kit.
The engine never holds a credential.

```ts
import pg from "pg";
import { createConnect, localKeyProvider, oauthProviders } from "@aaply/connect";
import { gmail } from "@aaply/connectors/gmail";
import { googleDrive } from "@aaply/connectors/google-drive";
import { notion } from "@aaply/connectors/notion";
import { serveConnect } from "@aaply/connect/http";

const connect = await createConnect({
  audience: "connect.aaply.internal",
  engineKeys: { "engine-2026-10": process.env.ENGINE_PUBLIC_KEY! }, // the engine's public key, base64url
  connectors: [gmail, googleDrive, notion],                          // imported modules of this build only
  pool: new pg.Pool({ connectionString: process.env.CONNECT_DATABASE_URL, max: 10, connectionTimeoutMillis: 2_000, statement_timeout: 5_000 }),
  keys: localKeyProvider({ keyId: "local-1", key: Buffer.from(process.env.CONNECT_WRAPPING_KEY!, "base64") }),
  adminKeys: { "backend-2026-10": process.env.BACKEND_PUBLIC_KEY! }, // the Aaply backend's public key, for /admin
  egress: { allowPrivate: ["db.internal.aaply.ai"] },                // operator config, never tenant data
  oauth: {
    redirectUri: "https://connect.aaply.ai/oauth/callback",            // registered with each provider
    returnOrigins: ["https://app.aaply.ai"],
    apps: {
      gmail: { provider: oauthProviders.google, clientId: process.env.GOOGLE_CLIENT_ID!, clientSecret: process.env.GOOGLE_CLIENT_SECRET! },
      "google-drive": { provider: oauthProviders.google, clientId: process.env.GOOGLE_CLIENT_ID!, clientSecret: process.env.GOOGLE_CLIENT_SECRET! },
      notion: { provider: oauthProviders.notion, clientId: process.env.NOTION_CLIENT_ID!, clientSecret: process.env.NOTION_CLIENT_SECRET! },
    },
  },
  files: { store: backendFiles },                                    // the backend's BlobStore, for Drive's upload and download
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

## Files

Connectors that take or give files (Drive's upload and download) do so by reference (ADR-0008 in the
flow repo): `files.store` is a `BlobStore` over the same object store the Aaply backend serves files
from, scoped by tenant, app and environment. A handler reads only a file named in its signed input or
one it stored itself; what a call stores and does not answer is deleted when the call ends. The
backend deletes the rest when runs release them (the engine's blob ledger); Connect never deletes a
file a run still names. Without `files`, those operations answer `connect/blob-no-store`.

## The database

`migrate(ownerPool)` (from `@aaply/connect/postgres`) creates the `aaply_connect` schema and the
`aaply_connect_app` role. Connect itself logs in as a role that is only a member of that one:

```sql
CREATE ROLE connect_app LOGIN PASSWORD '...' IN ROLE aaply_connect_app;
```

Every tenant's rows sit behind forced row-level security. `createConnect` refuses to start as a
superuser, a role that can bypass row security, or the schema's owner, and refuses a database made by
another build (pre-1.0 builds do not migrate). Run `connect.purgeExpired()` every minute from any
instance to delete expired replay claims; it deletes in batches until none are left (up to 5 s).

`resolve` reads by the `connections_resolve` index, so a call costs the same with 200 or 200,000
connections. Measured on one process against a local PostgreSQL 16 (warm cache, a pool of 10): a read
costs about 1.9 ms p50 and 2.6 ms p95 in all, of which about 1.4 ms is Connect's own; 64 calls in flight
run at about 1,500 calls per second, bound by CPU.

## The admin API

The Aaply backend administers Connect over `POST /admin/<operation>`, each request signed with the
backend's Ed25519 key (`adminKeys` in `createConnect`). The signature covers Connect's audience, the
method, the path, the time, a nonce and the body, so a request cannot be sent to another Connect,
changed, or sent again, and is refused when more than a minute away from Connect's clock. The backend
uses `createAdminClient({ url, audience, signer }).as(person)`, where `person` is
`{ tenantId, domain, id, roles }` as the backend knows them: every request is held to that tenant.
The signature does not hide the body (a new connection's secret travels in it), so the admin hop runs
over TLS, like `/perform`.

Connect decides the permission itself. Installing connectors, policy, operation contracts, the
business's own connections and the admin log need the tenant's `connect-admin` role. A person
connects only their own account (an admin does not connect someone else's), and sees, changes and
removes only their own; an admin may see and remove any. Every change is written to the admin log in
the change's own transaction (the service's role can only add to it), without secrets; changes made
through `connect.admin` in the deployment's code are logged as the operator's. The log is kept until
the deployment removes old entries itself (the service's role cannot): set a retention that suits
the business's audit needs.

## Connecting accounts with OAuth

Providers are data (`oauthProviders.google`, `oauthProviders.notion`); a connector names only the scopes
it needs, and `ConnectOptions.oauth.apps` gives Aaply's client at the provider per OAuth connector.

1. The backend calls `startOAuth({ scope, connectorId, owner, returnTo, reconnect?, expectAccount? })`
   as the person (checked like creating the connection, or changing it for `reconnect`) and redirects
   their browser to the link at once, never showing it. `returnTo` must be on one of `returnOrigins`.
2. `GET /oauth/start` works once, within two minutes: it binds the attempt to that browser with a
   `__Host-` cookie and sends it to the provider with PKCE (S256). Which browser opens the link
   cannot be proved, so for a person's own connection the backend gives `expectAccount` (the email
   it knows them by): any other account is refused when they come back.
3. `GET /oauth/callback` takes the attempt once, only with that cookie, trades the code, learns which
   account it is, and saves the connection: a new one, or the same account's again (another account
   where one is connected is refused). The change is logged as the person's. The browser lands on
   `returnTo` with `connect=ok&connection=<id>` or `connect=error&reason=<code>`.

A connection holds one account per connector, owner and environment kind, with only the scopes its
connector asks for (a sign-in that unticked one is refused). Tokens are renewed when they have under a
minute left or the service refuses them: once per connection at a time (in a process, and across
instances with a lease row), on the renewal's own clock rather than any caller's, and saved before the
lease is released, so a rotated refresh token is never lost. Only the provider saying the grant is gone
(`invalid_grant`) marks the connection `reauth` (calls answer `connect/reconsent` until the person
connects again); a refused client secret or an outage is retryable and reported to the `observer`.
Removing a connection revokes the grant at the provider, unless another connection in the same scope
uses that account (a provider revokes the account's whole grant to Aaply's client). Attempts live in a table only Connect's own SQL functions
touch, and `purgeExpired` removes old ones.

## Databases

A tenant's own PostgreSQL database is a connector declared as data, not code: `admin.installSql(scope,
definition)` stores it for the scope (see `SqlConnectorDefinition` in `src/sql/definition.ts`), and a
connection holds where to reach it (`{ host, port, database, user, tls, ca?, pooler? }`) with
`{ password }` as its sealed secret. Each operation is one parameterised statement; input reaches it only
as bind parameters. The definition compiles into a kit connector, so every check of the kit applies, and
each operation's statement digest is its contract's `implementation`: a flow pinned to an operation is
pinned to its exact SQL, and changing a statement is a new pin.

- Every statement is sent with the extended protocol, which runs exactly one command, and with
  `standard_conforming_strings` on, whatever the database's own settings.
- Reads run in a `READ ONLY` transaction, so a write hidden in a read is refused by the database. That is
  not a full boundary (dblink, `pg_notify` and advisory locks still work): give a connection that only
  reads a database role that can only read.
- A call reads at most 4 MiB from the database, and the session's state (settings, locks, temporary
  tables) is discarded after each call.
- A call stopped before `COMMIT` is sent closes its socket, so the database rolls it back; once `COMMIT`
  of a write is sent, a failure or a stop is `unknown`.
- Each call sets `statement_timeout` and `lock_timeout` from the call's budget.
- A write de-duplicates on a business reference (`insert … on conflict do nothing returning …` with
  `onConflictEmpty`), so the engine may send it again safely.
- A failure before `COMMIT` is retryable (connection, timeout, serialization) or final (a declared
  SQLSTATE in `errors`, or any other database error); a failed `COMMIT` on a write is `unknown`.
- The database host is checked by egress like any other. A private address needs `allowPrivate` and
  the tenant in `egress.sqlPrivateTenants` (the allowlist is the operator's, not every tenant's), and TLS
  may be off only to such an address.
- Installing a changed definition keeps the four it replaced serving runs pinned to them, so a booking
  made before the change can still be undone after it.
- `admin.operations(scope)` lists the contracts a host pins with the engine's `pinActionContracts`.

## Secrets

Each connection's secret is sealed with AES-256-GCM under its tenant's data key, bound to the tenant,
connection and secret version; data keys are wrapped by the `KeyProvider`. Revoking a connection deletes
its secret. Deleted rows can live on in database backups until those age out.

An API key connection's secret is its headers, `{ "header:authorization": "Bearer …" }`; an OAuth
connection's holds `accessToken`.

## Egress

Every socket Connect opens is checked where it connects: loopback, private, link-local, metadata, CGNAT,
multicast, reserved and tunnelling IPv6 ranges are refused unless the operator's `allowPrivate` names the
CIDR or host. A refused request counts as never sent. A host name in `allowPrivate` may resolve to any
address, so prefer CIDRs. Connector requests keep at most `connectionsPerOrigin` sockets (default 64) per
origin; calls beyond that wait for one.

Connect has no rate limiter of its own (the engine's lanes pace work per tenant and connector); put a
request limit in front of `/perform` at the load balancer if the network it listens on is shared.
