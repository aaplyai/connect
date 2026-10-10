# @aaply/action-contract

The contract between the Aaply Flow Engine and whatever performs its actions:
Aaply Connect, the connector kit's port, or a test fake. No dependencies.

The engine approves a named action and hands it over as an **approved action**. The
performer checks it again, binds the connection role to a real account, performs the
action and answers with an **outcome**. Both sides use the same validator from this
package, so "valid" means the same at dispatch and at the adapter. The connector kit
imports this package and never the engine.

```ts
import { refuse, verifyApprovedAction, type ActionPort, type ApprovedAction } from "@aaply/action-contract";
```

`@aaply/flow` re-exports the parts of the contract a host meets; the rest is
imported from here. Two named entries hold what is not every caller's
business ([ADR 0016](../../docs/adr/0016-public-entry-points.md)):

| Entry | What is in it |
| --- | --- |
| `@aaply/action-contract` | The contract: envelopes, signing, outcomes, refusals, operation contracts, delivery, files, JSON and schemas (below) |
| `@aaply/action-contract/conformance` | The port conformance suite and the helpers a performer's tests build envelopes with |
| `@aaply/action-contract/internal` | Freezing exported tables and the bounded pattern matcher, shared by this repository's packages; not public API |

## What is in it

| Area | Exports |
| --- | --- |
| Approved actions | `ApprovedAction`, `ACTION_CONTRACT_VERSION` (`1`), `ApprovalEvidence`, `ActionOrigin`, `IdentityRef`, `ActionPort`, `checkApprovedAction`, `verifyApprovedAction`, `MAX_ACTION_TIMEOUT_MS`, `DEFAULT_CLOCK_SKEW_MS` |
| Signing | `ActionProof`, `ApprovedActionSigner`, `ApprovedActionVerifier`, `approvedActionSigningBytes`, `signApprovedAction`, `hmacActionSigner`, `hmacActionVerifier`, `approvalBinding`, `UNSIGNED_PROOF` |
| Outcomes | `ActionOutcome` (`ok` with `withheld?`, `retryable` with `retryAfterMs?` and `limit?`, `final`, `unknown`, `pending` with `ref?`), `ActionError`, `normalizeOutcome`, `isActionOutcome`, `NormalizeOutcomeOptions`, `RateLimitBucket`, `MAX_PENDING_REF_LENGTH`, `MAX_ACTION_OUTPUT_BYTES` |
| Refusals | `CONNECT_REFUSALS` (each code and its `final` or `retryable` outcome), `ConnectRefusalCode`, `isRefusalCode`, `refuse` |
| Operation contracts | `OperationContract`, `OPERATION_CONTRACT_VERSION`, `isOperationContract`, `operationDigest`, `OperationCompletion`, `isOperationCompletion`, `MAX_COMPLETION_WINDOW_MS` |
| Environments | `ENVIRONMENT_KINDS`, `UNDECLARED_ENVIRONMENT` (`production`), `isEnvironmentKind`, `environmentAllows` |
| Contract versions | `ACTION_CONTRACT_VERSIONS`, `ActionPortDescription`, `isActionPortDescription`, `pickContractVersion`, `MAX_DESCRIBED_CONTRACTS`, `CONTRACT_UNSUPPORTED_RETRY_MS` |
| Correlation | `isTraceparent`, `TRACEPARENT_RE` |
| Completion | `CompletionRequest`, `CompletionResult` (`now`, `late`, `already` or `stale`) |
| Delivery | `DeliverRequest` (`{ event, correlation, payload, dedupeKey?, connection? }`, what the engine's `deliver` takes; `connection` is `{ id, subjectId }`, the connection the event came from and its owner, so it wakes only that owner's run), `DeliverConnection`, `DeliverResult`, `isDeliverRequest`, `isDeliverConnection`, `DELIVER_EVENT_RE`, `DEDUPE_KEY_RE` |
| Files | `BlobRef`, `checkBlobRef`, `isBlobRef`, `makeBlobRef`, `copyBlobRef`, `blobBinding`, `blobDigestSync`, `findBlobRefs`, `hasBlobRefs`, `mapBlobRefs`, `BlobConstraint`, `blobValueProblem`, `blobConstraintCovers`, `schemaUsesBlob`, `BLOB_REF_SCHEMA`, `BLOB_REF_KEY`, media-type helpers and limits (see [Files](#files)) |
| Conformance (`/conformance`) | `actionPortConformance`, `blobPortConformance`, `draftApprovedAction`, `draftApproval`, `sealApprovedAction`, `conformanceVerifier`, `CONFORMANCE_SCOPE`, `CONFORMANCE_AUDIENCE`, `CONFORMANCE_KEY` |
| Shared types | `Scope`, `ActorKind`, `Risk`, `riskAtLeast`, `ActionPurpose`, `ActingFor`, `EnvironmentKind` |
| JSON, schemas, hashing | `canonicalJson`, `checkJson`, `cloneJson`, `jsonEqual`, `validateValue`, `checkSchema`, `JsonSchema`, `sha256Digest`, `isSha256Digest`, `Diagnostic` (with an optional RFC 6901 `pointer` and `hint`), `DiagnosticBag`, `DiagnosticsError`, `formatPath`, `jsonPointer` |

## The envelope

An `ApprovedAction` is plain JSON. It carries:

- the performer it is for (`audience`) and when it was issued (`issuedAt`);
- the scope and environment;
- the effect, attempt and purpose, and for an undo or a check the write it is about (`target`),
  and for an undo the action id of that write (`undoes`);
- the idempotency key;
- the action's id, effect, idempotency, risk and pinned operation-contract digest (for an undo,
  the undo operation's own risk floor and idempotency when the engine has its contract, else
  `none` and `true`);
- the connection role;
- the input and its `sha256:` digest;
- its origin (run, flow version and hash, step, revision), with `causedBy`: the person who set
  the write in motion, on every attempt, undo and check of it;
- the actor that caused this attempt (with `authTime`, when they last signed in, if their
  request said), and the run's person;
- the review evidence, bound (`binding`) to the action, run, name, item and input it covered
  (with the reviewer's `authTime` when known), and the admission policy version;
- the deadline and timeout (at most 7 days);
- a completion token;
- the W3C `traceparent` of the request that set the work in motion, when there was one, for
  correlation only: a performer never refuses an envelope for it (`isTraceparent`);
- the engine's `proof`.

It **never** carries an account, a credential or a secret. It is a grant, though: whoever
holds a valid one can have the action performed. So the engine's host signs it for one
performer, and the performer verifies it before anything else. See
[Connectors](../../docs/connectors.md#the-approved-action) for every field.

### Signing

This package defines only what is signed: `approvedActionSigningBytes(action)`, a fixed tag
and the canonical JSON of the envelope without `proof`, so every field is covered. Who holds
which key is the hosts': the engine is given an `ApprovedActionSigner`, the performer an
`ApprovedActionVerifier`, either of which may be async (a KMS).

```ts
const signer = hmacActionSigner({ keyId: "2026-10", secret });     // the engine's host
const verifier = hmacActionVerifier({ "2026-10": secret, "2026-04": previous }); // the performer's host
const signed = await signApprovedAction(unsigned, signer);
const checked = await verifyApprovedAction(value, { now: Date.now(), audience: "connect.prod", verifier });
```

The HMAC pair shares one secret (at least 32 bytes), so it suits an engine and a performer
in one trust domain. Across trust domains, `ed25519ActionSigner` and `ed25519ActionVerifier`
(Web Crypto; `generateEd25519KeyPair` makes a pair) let the performer verify but never sign.
The key is the engine's own; never a service's credential.

An operation contract may carry an `implementation` digest: an operation whose behaviour is
declared data (a SQL statement, a request template) sets it, so a flow's pin covers that exact
text. It enters `operationDigest` only when present.

### Checking

`checkApprovedAction(value, { now, skewMs? })` checks, in this order:

1. the contract version;
2. that the value is plain JSON;
3. the shape (unknown fields are allowed; an undo or a check names its `target`, and an
   undo the write it `undoes`; `timeoutMs` is at most 7 days), that a `reconcile` is a read
   and a `compensate` a write, and that a `compensate` has risk `none`
   (`connect/approval-invalid`) and is idempotent (`connect/idempotency-mismatch`): an undo
   is sent unreviewed, and again after an unknown answer;
4. that its times are believable: the deadline is no later than `issuedAt + timeoutMs`
   (`connect/invalid-envelope`), and it was not issued in the future nor is due later than
   `now + timeoutMs`, give or take `skewMs` (default 30 s; `connect/clock-skew`);
5. the deadline (`connect/late`, retryable) and the review's `notAfter`
   (`connect/expired`, final);
6. that `inputDigest` is the input's;
7. that review evidence is bound to this action, run, name, item and input, and, for a `run`
   of a reviewed action, evidence of the matching kind for exactly this input, with an
   approval never from the run's own person.

`verifyApprovedAction(value, { now, skewMs?, audience, verifier })` runs those, then checks
that the envelope is for `audience` (`connect/wrong-audience`) and that its proof verifies
(`connect/proof-invalid`; an unsigned `none` proof never does). A verifier that throws is
`connect/unavailable` (retryable). A performer runs `verifyApprovedAction`.

Both answer `{ ok: true, action }` with a detached copy, or `{ ok: false, outcome }` with
the refusal to return. Neither throws.

## Refusals

A refusal before anything is sent is `final` or `retryable`, never `unknown`, so the
engine never reconciles a call that was not made. `refuse(code, message, { detail?,
retryAfterMs?, limit? })` builds it with the tabled outcome (`retryAfterMs` and `limit`, the
rate-limit bucket, only on a retryable one). People see `message`, and staff also
see `detail`.

| Outcome | Codes |
| --- | --- |
| `final` | `connect/invalid-envelope`, `expired`, `wrong-audience`, `proof-invalid`, `replayed`, `unknown-action`, `contract-mismatch`, `effect-mismatch`, `idempotency-mismatch`, `invalid-input`, `no-connection`, `not-own-connection`, `environment-mismatch`, `no-subject`, `reconsent`, `connection-revoked`, `policy-denied`, `approval-invalid`, `egress-denied`, `disabled` |
| `retryable` | `connect/contract-unsupported` (with `retryAfterMs`, `CONTRACT_UNSUPPORTED_RETRY_MS`), `late`, `clock-skew`, `rate-limited`, `unavailable` |

`connect/late` (this attempt's deadline passed) is retryable: the engine sends the next
attempt with a new envelope. `connect/expired` (the review's `notAfter` passed) is final:
the review must be given again. `connect/replayed` is a second delivery of one attempt of a
write that does not de-duplicate, refused by a performer that keeps a replay guard; the first
delivery may have been performed, so the engine records it for a write as `unknown`, not failed.
`connect/environment-mismatch` is a call whose `environment` (`production`, `preview` or
`test`) is not the kind of connection the performer found; a connection that declares no kind
is production (`environmentAllows`). `connect/contract-unsupported` is retryable: during a
rollout the engine sends the same attempt again until it reaches a performer that serves the
version, so it is checked before a replay guard is claimed.

## Output size

An `ok` output is stored whole in the run's state and event log, so it is at most
`MAX_ACTION_OUTPUT_BYTES` (1 MiB of JSON). `normalizeOutcome(raw, effect, {
maxOutputBytes? })` fails a read over it (`final`, `flow/output-too-large`) and withholds a
write's: `{ status: "ok", output: null, withheld: { bytes } }`, since the write was applied.
A performer may withhold it first and say so the same way. Large or binary content is stored
by the host and the output names it with a file reference (below), never inlines it: the cap
counts the reference's JSON, never the bytes it names.

## Files

A `BlobRef` names content the host stores ([ADR-0008](../../docs/adr/0008-blob-references.md)):

```json
{ "$blob": 1, "id": "b-7Gk2", "digest": "sha256:9f86…", "size": 48213,
  "mediaType": "application/pdf", "name": "invoice.pdf", "binding": "sha256:3c1a…" }
```

`binding` is `blobBinding(scope, ref)`, a digest over the scope, `id`, `digest`, `size` and
`mediaType`. It is a check, not a secret, and a reference is never a capability on its own:
access is always the host's lookup of `(scope, id)`. `checkBlobRef(value, scope?)` answers
`null` or the problem (`malformed`, or `foreign` for another scope's reference or one changed
since it was made); `makeBlobRef(scope, parts)` builds one. The schema subset's `blob` keyword
(`true` or `{ mediaTypes?, maxBytes? }`) types one and stands alone. `blobPortConformance(port, {
call })` is the case every port passes: an envelope whose input names another scope's reference
is refused `connect/invalid-input` (final) and nothing is performed.

`normalizeOutcome` never throws: anything that is not an outcome (`isActionOutcome` is
false: not plain JSON, not an object, or an unknown `status`) becomes `retryable` for a
read and `unknown` for a write, with code `flow/bad-outcome`. The engine refuses such a
completion with `invalid` rather than record it.

## Operation contracts

An `OperationContract` is what a flow relies on about an operation: `effect`,
`idempotent`, `irreversible`, `compensate` (an action id), `riskFloor` and the input and
output schemas. `operationDigest(contract)` is the `sha256:` digest of its canonical JSON.
A flow pins it at publish. The performer serves any implementation with that digest, and
refuses a pin it does not serve with `connect/contract-mismatch`.

An operation whose service reports long after a request may also declare
`completion: { windowMs }` (a whole number of milliseconds up to 30 days,
`MAX_COMPLETION_WINDOW_MS`): how long the engine waits, from the first `pending`, for its
completion. Like every optional field, it is in the digest only when present, so no existing
pin changes.

## Conformance

Every action port runs the same cases, from `@aaply/action-contract/conformance`. They are
framework-free, and each one throws on failure:

```ts
import { actionPortConformance } from "@aaply/action-contract/conformance";

for (const c of actionPortConformance(port, { read, write, performed: () => sent.length })) it(c.name, c.run);
```

The suite signs its envelopes with `CONFORMANCE_KEY` for `CONFORMANCE_AUDIENCE`, so build the
port under test with that audience and `conformanceVerifier()`, or pass `audience` and a
`signer` its verifier accepts.

The suite checks that:

- a well-formed read is performed;
- non-envelopes, envelopes of other versions, malformed envelopes (no audience, no proof),
  envelopes for another performer, unsigned, changed after signing or signed by a stranger,
  envelopes issued in the future or due beyond their timeout, missed deadlines (retryable),
  expired reviews, mismatched digests, unknown actions and unserved pins are refused with
  their tabled outcomes;
- an undo or a check without a `target`, an undo without `undoes`, and a check sent as a
  write, are refused;
- with a `write`, a write sent as a read, a write whose review covers other input, is
  missing, or was given for another action or run, and (unless the call says it is a declared undo, `undo: true`) the write sent as
  an undo, are refused too;
- with `undos` (declared undos, each with the write it `undoes`, its risk floor and its
  idempotency), an undo whose floor is above `none`, or that does not de-duplicate, is refused
  both as the engine states its own values and as it sends an undo it has no contract for
  (`none`, `true`), and a proper undo sent for a write that does not declare it is refused;
- a call of an environment kind the port's connection does not serve is refused
  (`environment-mismatch`, or `no-connection` from a resolver that finds none of that kind;
  `environment` is the port's own kind, production by default, and `foreignEnvironments` the
  others to send);
- a read is performed whatever its `traceparent`, a malformed one included;
- a port that `describe()`s itself lists contract 1 and refuses a version it does not list;
- an attempt refused for its contract version (`contract-unsupported`) is performed when the
  same attempt is sent again in a version the port serves, as the engine sends it: the read,
  and with `performedWrite` (best a write that does not de-duplicate) that write too, so a port
  that claims its replay guard before it checks the version fails;
- with `performedWrite` marked `idempotent: false` (its operation does not de-duplicate), the
  same signed envelope sent twice is performed once and the second answer is `connect/replayed`;
- nothing was sent before any refusal (`performed`).

## Versioning

`contract` is an integer, versioned apart from the packages. Additive optional fields do not
bump it. A performer serves version N and N−1. Deploy a performer's contract before the
engine's: a performer accepts fields it does not know (they are signed), but refuses an
envelope that lacks one it requires. An `ActionPort` may `describe()` the versions it serves
(`{ contracts: [...] }`); an engine sends the highest one both know (`pickContractVersion`),
and a port without `describe` is sent contract 1. See
[ADR-0002](../../docs/adr/0002-approved-action-contract.md).
