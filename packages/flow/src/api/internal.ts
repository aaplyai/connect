/**
 * `@aaply/flow/internal`: engine internals other packages of this repository
 * share with the engine, so that each question has one answer. NOT public
 * API: nothing here is covered by versioning, and it may change or go away
 * in any release. Only the packages api-surface.test.ts allows (the
 * toolkit) may import it.
 *
 * - `secretsOf`: where a definition's secret data reaches (the taint the
 *   compiler, views and export masking use), for the toolkit's masking and
 *   `flow diff`.
 * - `FLOW_HINTS`: the hint table the toolkit extends.
 * - `readCallEnd`, `CALL_ACTOR`, `CALL_START_RETRIES`: the call rules the
 *   toolkit's scenarios replay (`checkFlowCalls` is public: a host's own
 *   catalog runs it at publish).
 */

export { CALL_ACTOR, CALL_START_RETRIES, readCallEnd } from "../calls.js";
export { FLOW_HINTS } from "../hints.js";
export { secretsOf, type SecretTracer } from "../secrets.js";
