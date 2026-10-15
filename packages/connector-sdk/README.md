# @aaply/connector-sdk

The kit for building **connectors**: adapters that let `@aaply/flow` act on outside
services (REST APIs, database gateways, SaaS apps such as mail, file storage or notes).
A connector declares operations; a flow calls them as actions named
`"<connectorId>.<operation>"`, e.g. `"example-notes.create"`.

The same contract serves the platform team and third-party developers: what a
connector may do is declared in a JSON manifest, and everything it does at run time
goes through the kit, which checks it against that declaration.

The kit depends only on [`@aaply/action-contract`](../action-contract), never on the
engine, so it can move to its own repository unchanged. Its own tests do too: they
take their types from the contract, and the end-to-end tests that run the kit under
the engine live with the engine (`packages/flow/test/connector-kit.test.ts`).

```ts
import { ConnectorError, defineConnector, createConnectorActionPort } from "@aaply/connector-sdk";
import { mockFetch, testConnector, connectorConformanceCases } from "@aaply/connector-sdk/testing";
```

## Writing a connector

```ts
export const notes = defineConnector({
  id: "example-notes",              // lowercase kebab case
  version: "1.0.0",                 // semver
  title: "Example Notes",
  auth: { kind: "oauth2", scopes: ["notes.read", "notes.write"] }, // or { kind: "apiKey" } / { kind: "none" }; `hosts` names where the credential goes
  egress: ["GET api.example.com/v1/notes/*", "POST api.example.com/v1/notes", "DELETE api.example.com/v1/notes/*"],
  operations: {
    create: {
      title: "Create a note",
      effect: "write",
      idempotent: true,             // the service de-duplicates on the key we send
      compensate: "delete",         // how the engine undoes it (cancelled run, changed answer)
      input: { type: "object", required: ["title"], properties: { title: { type: "string", minLength: 1 } }, additionalProperties: false },
      output: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
      egress: ["POST api.example.com/v1/notes"],   // optional: narrower than the connector's
      async handler(input: { title: string }, ctx) {
        const res = await ctx.http({
          method: "POST",
          url: "https://api.example.com/v1/notes",
          headers: { "idempotency-key": ctx.idempotencyKey },
          json: { title: input.title },
        });
        return res.ensureOk().json();   // returning = applied
      },
    },
    delete: { /* effect: "write", idempotent: true, ... */ },
  },
});
```

`defineConnector` validates the definition and returns a frozen connector, or throws a
`DiagnosticsError` whose diagnostics have stable codes (all `connector/...`, listed
below). `validateConnector(def)` returns the diagnostics without throwing.

**Operations.** Each declares `effect` (`read` or `write`), an `input` schema (must be
`type: "object"`) and an `output` schema, in the engine's closed JSON Schema subset.
Names are camelCase, optionally dotted (`files.upload`).

**Undo semantics (writes).** Every write declares at least one of:

| Flag | Meaning |
| --- | --- |
| `idempotent: true` | Sending it twice has the effect of once: the service de-duplicates on `ctx.idempotencyKey` (POST, PATCH) or by nature (PUT, DELETE treating "already gone" as done). |
| `compensate: "<op>"` | Another write of this connector undoes it. The undo must be idempotent with risk floor `none`: the engine sends it unreviewed, and again after an unknown answer. The port runs an undo only for the write that declares it (the envelope's `undoes`), and refuses any other. |
| `irreversible: true` | It cannot be undone (a sent message, a payment). Not combinable with `compensate`. |

Mark an undo `undoOnly: true` when it is safe only as the undo of what its write made (a
delete bound to one create's page or file): a flow may then name it only as that write's
`compensate`. Publish refuses it as a step (`connector/flow-undo-only`), and the port refuses
it sent as one (`connect/effect-mismatch`). Every field of that `compensate`'s input must read
the write's output, never a literal or the write's input (`connector/flow-undo-unbound`). That
binds the undo to what the write made only through output fields the service made, which no read
exposes and the write does not echo from its input: keep echoed input (a parent id, a title)
out of an undo-only operation's binding, and out of its write's output. It must be another operation's `compensate`
(`connector/undo-only-undeclared`), idempotent with risk floor `none` (errors for it), and it
is part of the operation contract.

`riskFloor` (`none`, `confirm`, `approval`) is the least review a flow must put in front
of a write; reads have none. A write must be allowed at least one POST, PUT, PATCH or
DELETE rule: GET and HEAD are treated as reads.

`scopes` (OAuth connectors) lists the scopes an operation needs, each one of the
connector's `auth.scopes`; a connection is checked for those alone (`scopesNeeded`). An
operation without it needs every scope the connector lists.

`completion: { windowMs }` (an operation whose handler defers) declares how long its
service may take to report: a whole number of milliseconds up to 30 days. The engine waits
that long from the first `pending` instead of the action's `timeoutMs`, and the `deferred`
sink gets it as `windowMs`. It is in the manifest and the operation contract, and in their
digests, only when declared.

`implementation: "sha256:…"` names the digest of declared data the host interprets in place
of handler code (a SQL statement). It is in the manifest, the operation contract and their
digests only when declared, so a flow's pin covers that exact data. A write that declares it
needs no POST, PUT, PATCH or DELETE egress rule: its effect is not an HTTP request.

**The handler** receives the validated input and `ctx`:

| `ctx.` | |
| --- | --- |
| `http(request)` | The only network access. See below. |
| `idempotencyKey` | Stable for every attempt of one effect. Send it to services that de-duplicate. |
| `signal`, `deadline` | Aborted / reached when the call must stop. `deadline` is on the host's clock. |
| `connection` | `{ id, role }`: the real connection the flow's connection role was bound to. |
| `log` | A logger that redacts by default (see Security). |
| `traceparent` | The W3C `traceparent` of the request that set the work in motion, when the engine sent a well-formed one; absent otherwise. For correlating logs. `ctx.http` also sends it as the `traceparent` header (unless the handler sets one) only for a connector with `propagateTrace: true`, which is off by default and in the manifest only when on. |
| `defer(ref)` | The service accepted the call and reports its result later: answer `pending` with the service's reference. Throws, so write `return ctx.defer(ref)`. |

Return the output (plain JSON) when the operation was applied. Throw a `ConnectorError`
for anything else:

```ts
throw ConnectorError.final("notes/not-found", "The note does not exist.");
throw ConnectorError.retryable("notes/busy", "Try again shortly.", { retryAfterMs: 5_000 });
throw ConnectorError.retryable("notes/quota", "This account's quota is used up.", { retryAfterMs: 60_000, limit: "connection" });
throw ConnectorError.unknown("notes/lost", "The service stopped answering.");
```

`limit` names the rate-limit bucket a retryable failure hit: `connection` (this account's
quota) or `connector` (the whole service's). The port sets `connection` itself on a 429 for an
`endUser` call; without a `limit`, a store with fair lanes pauses the call's lane.

Messages are shown to people: never put payload values or text the service echoed in them. Put that in the `detail` option instead (`{ detail }`, up to 2000 characters), which only staff see.

### `ctx.http`

```ts
const res = await ctx.http({ method: "GET", url, query: { limit: 20 }, headers, json, body, timeoutMs, maxResponseBytes, auth });
res.status; res.headers; res.url; res.text(); res.json(); res.ensureOk();
```

- The method and URL of every request **and every redirect hop** must match one of the
  operation's egress rules. Redirects are followed by hand (at most 5) and re-checked;
  303 (and 301/302 after POST) turn into GET, as in browsers.
- https only, default port only, no credentials in URLs, no IP literals, no loopback,
  private or link-local names, no encoded dot segments.
- The connection's credential is added as headers by the host's `CredentialProvider`,
  only for a host the connector's `auth.hosts` names (exact names or `*.` wildcards, each
  allowed by its egress); it is dropped when a redirect leaves the first request's origin.
  Left out, `auth.hosts` is the one host the egress names; a connector whose egress names
  several hosts, or a wildcard, must list them (`connector/auth-hosts-required`), so a
  token never follows a handler to a file or CDN host. A request to any other allowed host
  goes without it (logged as `http.no-credential`). `auth: false` skips it on a credential
  host too (pre-signed URLs). A handler cannot set `host`, `content-length` and similar headers.
- Bounded: the operation's deadline and an optional per-call `timeoutMs`; response
  bodies are read up to 5 MiB (a call may lower it), request bodies up to 5 MiB, at most
  50 requests per operation call. Limits are configurable by the host.
- Failures are thrown as `ConnectorError`s with outcome semantics already applied.

Egress rules are `"METHOD host/path"`:

| Rule | Allows |
| --- | --- |
| `GET api.example.com/v1/notes` | exactly that path (any query) |
| `GET api.example.com/v1/notes/*` | any path starting with `/v1/notes/` |
| `GET *.example.com/files/*` | any subdomain of example.com (not example.com itself) |

Methods are `GET HEAD POST PUT PATCH DELETE`. No scheme (https is implied), no port
other than `:443`, `*` only as a leading `*.` in the host and at the end of the path.

### `ctx.blobs`

Files, images, PDFs and audio pass between operations by reference (ADR-0008): the bytes live
in the host's file store, and inputs and outputs carry a `BlobRef` (from
`@aaply/action-contract`) that a schema types with the `blob` keyword.

```ts
download: {
  title: "Download an invoice", effect: "read",
  input: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
  output: { type: "object", required: ["file"], properties: { file: { blob: { mediaTypes: ["application/pdf"] } } } },
  async handler(input: { id: string }, ctx) {
    const res = (await ctx.http({ url: `https://api.example.com/v1/invoices/${input.id}.pdf` })).ensureOk();
    return { file: await ctx.blobs.put(res.body, { mediaType: "application/pdf", name: `invoice-${input.id}.pdf` }) };
  },
},
```

- `ctx.blobs.put(bytes, { mediaType, name? })` stores a `Uint8Array` and answers its
  reference. The kit computes the digest and size, normalises the media type and sanitises the
  name, and checks that the store's answer describes exactly those bytes, in the call's scope.
- `ctx.blobs.get(ref)` reads one. **A call reads only the references in its input (signed by
  the engine) and those it stored**; any other is `connect/blob-not-granted`, even within the
  tenant, so a handler cannot read a tenant's files by guessing or remembering ids. A reference
  made for another tenant, app or environment, or changed since, is `connect/blob-foreign`; one
  whose content is gone is `connect/blob-not-found`; bytes that do not match the reference's size
  and digest are `connect/blob-corrupt`.
- **Limits per put and get** (`blobLimits` on the port, `DEFAULT_BLOB_LIMITS`): 25 MiB a file,
  20 puts and 64 MiB stored and read in all per operation call (`connect/blob-too-large`,
  `connect/blob-too-many`). The HTTP limits still bound what `ctx.http` moves, so a host that lets
  connectors move large files raises both.
- **References in the input** are checked against the envelope's scope before anything runs
  (`connect/invalid-input`). **References in an `ok` output** must be ones the call was given or
  stored (`connect/bad-output`: `final` for a read, `unknown` for a write).
- **Nothing a call stores is left behind silently.** What a call stored and its `ok` output does
  not name (the handler failed, deferred or timed out, or the output was refused or withheld) is
  deleted when the call ends, without holding up the answer (pass the port a `waitUntil(work)` on a
  platform that stops work once a response is sent); a put that finishes after the call is
  deleted when it does; a delete that fails is reported to `observer.error`
  (`connector-blobs:cleanup`). An answer ready only after the deadline names nothing the call
  stored: a read's is `retryable` (`connect/timeout`), a write's output is withheld, and the files
  are deleted. After the call, `ctx.blobs` is closed (`connect/closed`). Handlers cannot delete
  otherwise: content a run still names is deleted after erasure, by the host.
- Without a store on the port, `ctx.blobs` throws `connect/blob-no-store`. A store that fails is
  `connect/blob-unavailable` (retryable); a `ConnectorError` it throws (a quota, say) is passed on.
  A malformed argument is `connect/blob-invalid`.

The host implements `BlobStore` (`put`, `get`, `delete`, each with the call's scope and a
`BlobCallContext` naming the connector, operation, connection and effect) over its own object
store, and answers `makeBlobRef(scope, { id, ...content })` from `put` with an id nobody can
choose. `memoryBlobStore()` is the in-memory one, for tests and one process. A deferred call's
later completion cannot store content through the kit: what it stored before deferring is
deleted.

## Outcomes

Every call ends in one of the engine's action outcomes. The outcome says **what
happened to the outside world**:

| Outcome | Meaning | The engine |
| --- | --- | --- |
| `ok` | Applied. The handler returned, and its output matched the output schema. | Records the output; a compensable write becomes a resource it can undo. |
| `retryable` | Not applied; transient. | Retries with backoff (honouring `retryAfterMs`). |
| `final` | Not applied; trying again will not help. | Fails the action. |
| `unknown` | May or may not have been applied. | Retries idempotent writes; otherwise reconciles or asks a person. |
| `pending` | Accepted; completes later. Produced by `ctx.defer(ref)`. | Waits for `completeAction`. |

How the kit decides:

- **Input** that fails the input schema is `final` (`connect/invalid-input`) and the
  handler never runs. **Output** that fails the output schema is `final` for a read and
  `unknown` for a write, since the write may have happened (`connect/bad-output`).
- **HTTP statuses** (`httpOutcome`, `httpError`, `res.ensureOk()`): 408, 425, 429, 500,
  502, 503, 504 are `retryable` (Retry-After honoured, codes `http/<status>`); every other
  non-2xx status is `final`.
- **Network errors** (`fetchErrorOutcome`): failing before anything was sent (DNS,
  connection refused, TLS) is `retryable`; a timeout or lost connection after sending is
  `unknown` for a write and `retryable` for a read.
- **Writes that may already have happened.** The kit tracks whether an unsafe request
  (POST, PUT, PATCH, DELETE) of this call may have been applied: it was sent and the
  service did not plainly refuse it (any answer other than 4xx, 501 or 503). From then on
  a failure of the write is `unknown`: a 500 on POST, a 404 on a follow-up GET, a crash.
  A `retryable` thrown by an `idempotent` write stays `retryable`, since a retry is
  de-duplicated. GET and HEAD never count, so a failed lookup before the write stays
  `retryable` or `final`.
- A handler that throws anything other than a `ConnectorError`, or runs past its
  deadline, is `retryable` (or `unknown` once a write may have happened).
- **Codes that only the kit's checks answer.** Some codes say the attempt was refused
  before anything ran: the envelope's version, proof, times, review, input or declared use,
  or a second delivery (`REFUSAL_ORIGINS` marks them `check`; `CHECK_ONLY_CODES` adds
  `connect/resolver-error` and `connect/invalid-connector`), and the engine acts on that: it
  sends the same attempt again after `connect/contract-unsupported`. Use your own codes in a
  handler (`notes/too-long`). A `ConnectorError` with one of these, or with any `flow/` code
  (`isCheckOnlyCode`), thrown during a call, by the handler or by a host hook it reached
  (credentials, signing, the file store), is answered as a fault of the handler:
  `connect/handler-error`, `retryable` or `unknown` as above, reported to `observer.error`,
  with the code in `detail`. A resolver that throws one is `connect/resolver-error`. The
  codes a call may meet (`connect/reconsent`, `connect/rate-limited`, ...: `call` in
  `REFUSAL_ORIGINS`) pass through.
- **A thrown error is read, never asked.** Whoever throws a `ConnectorError` (a handler, a
  host hook, another copy of the kit), the kit reads its fields once (`kind`, `code`,
  `message`, `retryAfterMs`, `limit`, `detail`) and builds the outcome from that copy; it
  never calls the error's methods, so a subclass's `toOutcome` or a getter that changes is
  not heard. One whose fields are not a `ConnectorError`'s is `connect/handler-error`. The
  port answers only an outcome with an outcome's shape, and `connect/internal` otherwise.

## Running connectors in a flow

```ts
const actions = createConnectorActionPort({
  audience: "connectors.prod",          // this performer: the engine signs every envelope for it
  verifier: hmacActionVerifier({ "2026-10": envelopeKey }), // the engine's envelope keys, by key id
  replayGuard,                          // required when a write does not de-duplicate (see below)
  connectors: [notes],
  connections: async (scope, { role, actingFor, subjectId, connectorId, environment }) =>
    store.find(scope, connectorId, role, environment, actingFor === "endUser" ? subjectId : null), // → { connectionId, grantedScopes, subjectId, environment } | null
  credentials: { headers: async ({ scope, connectionId }) => ({ authorization: `Bearer ${await vault.token(scope, connectionId)}` }) },
  deferred: (call) => pending.save(call),   // optional: { scope, runId, effectId, attempt, action, purpose, ref, token, windowMs? }
  clock,      // the runtime's clock: the approved action's deadline is measured on it
  fetch,      // optional; default globalThis.fetch
  log, observer, limits,
});
createFlowRuntime({ actions, envelopes: { audience: "connectors.prod", signer: hmacActionSigner({ keyId: "2026-10", secret: envelopeKey }) }, ... });
```

The port's `run(approved, signal)` takes the engine's **approved action** (contract 1 of
`@aaply/action-contract`; see [Connectors](../../docs/connectors.md#the-approved-action)).
An approved action is a grant, so the port believes only one signed for its `audience`
whose proof its `verifier` accepts. An envelope of a contract version it does not serve is
refused (`connect/contract-unsupported`, retryable after 30 s). `port.describe()` answers the
envelope versions it serves (`{ contracts: [1] }`), which the engine asks before sending.

**Replays.** A `ReplayGuard` (`claim(key, until)`, true for the first claim) lets the port
perform each attempt of a write whose operation does not de-duplicate at most once: it
claims `replayKey(scope, effectId, attempt)` until the envelope's deadline, last before
anything is sent, and refuses a second delivery (`connect/replayed`). It must be shared by
every instance of the port (a unique database row, or Redis `SET key 1 NX PXAT until`);
`memoryReplayGuard()` suits one process. A guard that throws refuses the call as
`connect/unavailable` (retryable), sending nothing. A port that serves any write that does
not de-duplicate cannot be created without one (it throws, naming the write).
`unsafeAllowReplays: true` lifts that, and a replayed envelope is then performed again
(a message or a payment sent twice): for tests, or a performer only an engine in the same
process can reach.

Before running an operation the port refuses, as `final` unless noted:

- an envelope that is malformed, past its review's `notAfter`, or whose `inputDigest` is
  not its input's (`connect/invalid-envelope`, `connect/expired`, `connect/invalid-input`);
- an envelope of a contract version this port does not serve
  (`connect/contract-unsupported`), `retryable`: the engine holds the write back unsent,
  spending no attempt, until the versions meet or its deferral bound passes;
- an envelope past its deadline (`connect/late`), or whose times do not fit this clock
  (`connect/clock-skew`; `skewMs`, default 30 s), both `retryable`;
- an envelope for another performer (`connect/wrong-audience`), or whose proof does not verify
  or that is unsigned (`connect/proof-invalid`); a verifier that cannot answer is
  `connect/unavailable` (`retryable`);
- a reviewed `run` without evidence for exactly this input, evidence bound to another action,
  run or item, an approval by the run's own person, or a write whose review is below the
  operation's `riskFloor` (`connect/approval-invalid`);
- an operation contract the flow pinned that is not the operation's current one
  (`connect/contract-mismatch`);
- an action no connector provides (`connect/unknown-action`);
- a write the flow declares as a read, a read used as an undo, a write used as a check
  (`reconcile`), or a flow marking a non-idempotent write idempotent (`connect/effect-mismatch`,
  `connect/idempotency-mismatch`);
- an undo (`compensate`) with an operation that no operation declares as its undo
  (`connect/effect-mismatch`), that does not de-duplicate (`connect/idempotency-mismatch`), or
  whose `riskFloor` is above `none` (`connect/approval-invalid`): an undo is never reviewed and
  may be sent more than once;
- an `undoOnly` operation sent as a step (`run`, `connect/effect-mismatch`);
- invalid input (`connect/invalid-input`);
- no connection bound to the flow's connection role (`connect/no-connection`);
- a connection of another environment kind than the envelope's `environment`
  (`connect/environment-mismatch`): the resolver says which kind a connection serves
  (`environment`), and one that says none is production;
- an `endUser` action without a person, or whose connection is not that person's own, and a
  business action on a person's connection (`connect/no-subject`, `connect/not-own-connection`).
  For `endUser` calls the resolver must return the connection's `subjectId`;
- a connection that has not consented to every scope the operation needs
  (`connect/reconsent`): its own `scopes`, or else all of the connector's, so a scope added
  for one operation asks only that operation's users to consent again;
- a second delivery of an attempt the replay guard already claimed (`connect/replayed`).

The credential is requested only when the handler makes its first request, at most once
per call. A `CredentialProvider` may throw a `ConnectorError` (e.g. `final` when the account
must be reconnected); anything else is `retryable`. `run` never throws. A provider with an
optional `refresh(request)` is asked for new headers when a credentialed request answers
401, at most once per call, and that request is sent once more (a 401 was not applied, so a
write may be sent again); a second 401 is final (`http/401`). The resolver's query and the
credential request carry the call's `environment` kind.

**Signed requests.** A provider with an optional `sign(request)` is called last on every
credentialed request (each same-origin redirect hop and the resend after a refresh
included), with the credential request and the request as it will be sent (`method`, `url`,
lower-case `headers`, `body` as bytes or null), and returns headers to add. The kit sends
exactly the bytes it gave the signer. A signer's `ConnectorError` is the answer; anything
else it throws is `connect/sign-failed` (retryable); headers that are not strings or that
the platform sets are `connect/credential-invalid`. See
[Connectors](../../docs/connectors.md#plugging-into-the-runtime).

**Deferred calls.** When a handler calls `ctx.defer(ref)`, the port gives the `deferred`
sink the call with its completion token, its `connector` and its `connectionId`, then
answers `pending`. The host keeps it under `deferredKey(deferral)` and, once the service
reports the result for that connection and `ref`, calls the engine's `completeAction` with
the token. Match on the key, never on `ref` alone: references are unique only within one
account.
Without a sink, or if the sink throws, the result could never arrive: the port answers `unknown` for a write and `retryable` for a read
(`connect/no-completion`). The token never reaches handler code.

**Conformance.** The port passes `actionPortConformance` from `@aaply/action-contract`,
including an attempt it refused for its version that is performed when sent again (pass a
write that does not de-duplicate as `performedWrite`); run it against your host's port too.

**Publishing.** `operationContracts([notes])` gives each operation's contract (effect,
idempotency, undo, `riskFloor`, schemas) keyed by action id, and `operationContractOf(connector,
op)` one of them. Pass them to `pinActionContracts` and `checkActionBindings` in `@aaply/flow`,
which check what the engine cannot see at run time: the flow's `risk` is at least each
operation's `riskFloor`, effects and idempotency match, irreversible operations have no
`compensate`, undo and reconcile calls name a write and a read, an undo is a declared one
that de-duplicates and needs no review, an `undoOnly` operation is never a step and its undo reads
only the write's output, an undo's or check's input names every field its operation requires and
none it forbids, and each call's pinned
digest is current (in production every call must be pinned).
`checkActionBindings(flow, operationContracts([...]))` reports the
`connector/flow-*` codes.

## Webhooks

A connector may declare `webhooks: { verify(request, ctx), parse(request, ctx) }`. The host
calls `handleWebhook(connector, { method, url, headers, body }, { connectionId, subjectId, secret })`
for a request its endpoint routed to one connection, with `subjectId` the connection's owner
from its own store (a person's `domain:id`, or `null` for the business's own): `verify` must
answer exactly `true` (check the signature over the raw `body` with `ctx.secret`, in constant
time), then `parse` turns the request into the contract's `DeliverRequest`s (at most
`MAX_WEBHOOK_DELIVERIES`), each given `connection: { id, subjectId }` from the options. The
host gives them to the engine's `deliver` in the connection's scope, with the owner as the
context's subject: an event from a person's own account then wakes only that person's run
(see [Connectors](../../docs/connectors.md#webhooks)). Without a well-formed owner nothing is
read (`connect/webhook-unavailable`). `handleWebhook` never throws; a refusal names a code and the HTTP status to answer:
`connect/no-webhooks` (404), `connect/webhook-unverified` (401),
`connect/webhook-unavailable` (503, send again) and `connect/webhook-invalid` (400). The
manifest says `webhooks: true`. Subscribing and renewing subscriptions is the host's.

## Security model

- **Declared egress.** A connector can only reach what its manifest lists, checked on every
  request and redirect hop, per operation. Names that point inside a network are refused at
  definition time; the network layer the platform runs connectors behind must still stop
  public names that resolve to private addresses (DNS rebinding), since names are all a
  declaration can check.
- **Injected credentials.** Handlers never see tokens: the host's `CredentialProvider` adds
  them as headers inside `ctx.http`, only for the first request's origin, and only when that
  is one of the connector's `auth.hosts`. Handlers cannot
  read them from `ctx`, responses, errors or logs.
- **Redacted logs.** `ctx.log.info("notes.listed", { count: safe(n), title })` logs
  `count` and `"[redacted]"` for `title`. Event and field names must be identifiers (no
  interpolation). The kit's own records carry method, host, status and duration, never
  paths, queries or bodies.
- **Bounded calls.** Deadlines, response and request size caps (5 MiB each, and 16 MiB of
  answers in all per operation call, pages included), redirect and request limits, and an
  output cap (`maxOutputBytes`, default 1 MiB, the engine's): a read over it fails
  (`connect/output-too-large`) and a write's output is withheld (`ok`, `output: null`,
  `withheld: { bytes }`, logged as `output.withheld`). Large content is named by reference
  (`ctx.blobs`): the cap counts the reference, not the bytes.
- **References are not capabilities.** A `BlobRef` is bound to its tenant, app and environment,
  and a handler reads only those its call was given or stored; the store answers by scope and id
  (see `ctx.blobs`).
- **Sandboxing later, same contract.** Today connectors run in-process: the kit cannot stop
  code that imports its own HTTP client or calls the global `fetch`; review and the
  conformance suite (which traps the global `fetch`) catch that. Third-party connectors will
  run in an isolated sandbox whose only network path is `ctx.http`, with the same manifest,
  handler contract and outcomes, so a conforming connector moves there unchanged.
- **Signed manifests later.** `manifestOf(connector)` is the connector minus its code, as
  JSON; `manifestDigest(manifest)` is `sha256:<hex>` of its canonical JSON. Equal manifests
  have equal digests, so a digest can be signed, reviewed, or pinned by a deployment; any
  change to egress, scopes, schemas or undo semantics changes it.

## Testing

```ts
const t = testConnector(notes, { routes: {
  "POST https://api.example.com/v1/notes": (req) => ({ status: 201, json: { id: "n-1", title: req.json().title } }),
}});
await t.call("create", { title: "Hi" });      // → ActionOutcome, with production checks
await t.run("create", { title: "Hi" });       // → output, or throws
await t.call("create", { title: "Hi" }, { traceparent }); // ctx.traceparent, as the port passes it on
t.mock.calls; t.logs; t.handlerCalls;
await t.http("create", { method: "POST", url: "https://elsewhere.example.org/" }); // throws connect/egress-denied
```

`testConnector(connector, { sign })` runs a request signer as the port would.

`mockFetch(routes)` answers `"METHOD https://host/path"` routes (a trailing `*` matches a
prefix) with `{ status, headers, json | body, delayMs }`, `{ networkError: "ECONNRESET" }`,
`{ hang: true }`, a `Response`, or a function of the request; unmatched requests get 404
and are listed in `unmatched`. It never touches the network.

`connectorConformanceCases(connector, samples)` returns framework-free `{ name, run }`
cases. `samples` gives one known-good call per operation: `{ input, routes, invalidInput? }`
(requests carry `authorization: Bearer test-token`). The cases check that the manifest is
valid and its digest stable; every operation has valid schemas and a sample; writes declare
undo semantics and undo operations are idempotent writes; invalid input is refused without
calling the handler; the sample succeeds through `ctx.http` alone with a schema-valid output;
egress to an undeclared host (directly, over plain http, or by redirect) is refused; and a
write sends `ctx.idempotencyKey`, unchanged across attempts (POST and PATCH must carry it when
the write claims to be idempotent).

```ts
for (const c of connectorConformanceCases(notes, samples)) it(c.name, c.run);
```

`testConnector(connector, { blobs: memoryBlobStore() })` gives handlers a file store; calls run
in `TEST_SCOPE` unless `scope` says otherwise, so references in inputs must be made for it
(`makeBlobRef(TEST_SCOPE, ...)`). A performer that takes references also runs
`blobPortConformance(port, { call, performed })` from `@aaply/action-contract/conformance`: an envelope
naming another scope's, a changed or a malformed reference is refused before anything is sent.

The example connector in `test/fixtures/example-notes.ts` shows all of this end to end.

## Diagnostic codes

Definition (`validateConnector`, `validateManifest`): `connector/invalid-shape`,
`unknown-field`, `invalid-field`, `invalid-id`, `invalid-version`, `invalid-auth`,
`auth-hosts-required`, `auth-host-not-in-egress`, `scope-not-declared`,
`too-large`, `no-operations`, `invalid-operation-name`, `invalid-effect`, `missing-schema`,
`invalid-schema`, `input-not-object`, `missing-handler`, `write-needs-undo`,
`write-undo-conflict`, `compensate-unknown`, `compensate-self`, `compensate-not-write`,
`compensate-not-idempotent` (warning), `compensate-reviewed` (warning: an undo with a risk
floor above `none`, which no flow can use), `undo-only-undeclared`, `read-with-write-option`, `write-without-unsafe-egress`,
`invalid-egress`, `egress-format`, `egress-method`, `egress-scheme`, `egress-not-https`,
`egress-credentials`, `egress-port`, `egress-host`, `egress-wildcard`, `egress-ip-literal`,
`egress-private-host`, `egress-path`, `egress-duplicate` (warning), `egress-not-declared`.

Flow bindings (`checkActionBindings` in `@aaply/flow`): `connector/flow-unknown-operation`,
`flow-effect-mismatch`, `flow-idempotency-mismatch`, `flow-risk-below-floor`, `flow-undo-mismatch`,
`flow-undo-undeclared`, `flow-undo-unpaired`, `flow-undo-not-idempotent`, `flow-undo-reviewed`,
`flow-undo-only`, `flow-undo-unbound`, `flow-input-mismatch`, and `flow/contract-mismatch`, `flow/contract-unpinned`, `flow/contract-invalid`.

Run time (`error.code` of outcomes): `connect/invalid-envelope`, `contract-unsupported`,
`expired`, `approval-invalid`, `contract-mismatch`, `no-completion`,
`unknown-action`, `invalid-connector`, `effect-mismatch`,
`idempotency-mismatch`, `invalid-input`, `bad-output`, `no-subject`, `no-connection`,
`not-own-connection`, `environment-mismatch`, `reconsent`, `resolver-error`, `credential-unavailable`,
`credential-invalid`, `sign-failed`, `egress-denied`, `egress-not-https`, `egress-forbidden-host`,
`bad-request`, `request-too-large`, `response-too-large`, `too-many-redirects`,
`too-many-requests`, `bad-response`, `network`, `timeout`, `cancelled`, `closed`,
`handler-error`, `internal`; and `http/<status>` for HTTP answers.

Files (`ctx.blobs`, thrown inside a call): `connect/blob-no-store`, `connect/blob-unavailable`
(retryable), `connect/blob-invalid`, `connect/blob-foreign`, `connect/blob-not-granted`,
`connect/blob-not-found`, `connect/blob-too-large`, `connect/blob-too-many`,
`connect/blob-corrupt`.

Webhooks (`handleWebhook`): `connect/no-webhooks`, `webhook-unverified`, `webhook-unavailable`,
`webhook-invalid`.
