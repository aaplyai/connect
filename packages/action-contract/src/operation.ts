/**
 * Operation contracts: what an action promises, apart from how it is built.
 *
 * A flow pins each action to the digest of its operation contract when it is
 * published. Whoever performs the action (Aaply Connect, the connector kit)
 * may run any implementation with that digest, so a security patch needs no
 * republishing; a change to the contract (its effect, its idempotency, its
 * undo, its risk floor, its schemas, its completion window, or the declared
 * implementation of an operation made of data, such as a SQL statement) does.
 */

import { isSha256Digest, sha256Digest, type Sha256Digest } from "./digest.js";
import { checkJson, isJsonObject, type JsonObject, type JsonValue } from "./json.js";
import { checkSchema, type JsonSchema } from "./schema.js";
import { DiagnosticBag } from "./diagnostics.js";
import { isOperationCompletion, type OperationCompletion } from "./completion-window.js";
import { isRisk, type ActionEffectKind, type Risk } from "./scope.js";

/** Version of the operation-contract digest's input. A new field that changes meaning bumps it. */
export const OPERATION_CONTRACT_VERSION = 1 as const;

/** What one operation promises. Plain JSON. */
export interface OperationContract {
  effect: ActionEffectKind;
  /** A write the performer de-duplicates, so it may be sent again. Reads are always safe to repeat. */
  idempotent: boolean;
  /** A write that cannot be undone. */
  irreversible: boolean;
  /** The action id (`<connectorId>.<operation>`) of the write that undoes this one. */
  compensate?: string;
  /** The least review a flow must put in front of the action. `none` for reads. */
  riskFloor: Risk;
  /** Schema of the input (`type: "object"`). */
  input: JsonSchema;
  /** Schema of the output. */
  output: JsonSchema;
  /**
   * How long the service may take to report a deferred (`pending`) result,
   * when that is longer than a request takes. The engine waits this long
   * for the completion instead of the call's `timeoutMs`.
   */
  completion?: OperationCompletion;
  /**
   * The digest of the implementation itself, for an operation whose
   * behaviour is declared data rather than code: a SQL statement, a
   * request template. A pin then covers that exact text, so changing it
   * needs the flow to be pinned again, as a contract change does. Code
   * connectors leave it out, so a security patch needs no republishing.
   */
  implementation?: Sha256Digest;
}

const KEYS = new Set(["effect", "idempotent", "irreversible", "compensate", "riskFloor", "input", "output", "completion", "implementation"]);

/**
 * Whether `value` is a well-formed operation contract: the known keys only,
 * valid schemas in the supported subset, and an object input schema.
 */
export function isOperationContract(value: unknown): value is OperationContract {
  if (!isJsonObject(value as JsonValue) || checkJson(value) !== null) return false;
  const c = value as Record<string, unknown>;
  if (Object.keys(c).some((k) => !KEYS.has(k))) return false;
  if (c.effect !== "read" && c.effect !== "write") return false;
  if (typeof c.idempotent !== "boolean" || typeof c.irreversible !== "boolean" || !isRisk(c.riskFloor)) return false;
  if (c.compensate !== undefined && (typeof c.compensate !== "string" || c.compensate.length === 0)) return false;
  if (c.completion !== undefined && !isOperationCompletion(c.completion)) return false;
  if (c.implementation !== undefined && !isSha256Digest(c.implementation)) return false;
  const bag = new DiagnosticBag();
  checkSchema(c.input, ["input"], bag);
  checkSchema(c.output, ["output"], bag);
  if (bag.hasErrors) return false;
  return (c.input as JsonObject).type === "object";
}

/**
 * The digest a flow pins: `sha256:` of the canonical JSON of the contract,
 * tagged with {@link OPERATION_CONTRACT_VERSION}. Key order and absent
 * optional fields do not change it, so a field added later (`completion`,
 * `implementation`) leaves the digest of every contract without it as it
 * was.
 */
export function operationDigest(contract: OperationContract): Sha256Digest {
  const body: JsonObject = {
    operationContract: OPERATION_CONTRACT_VERSION,
    effect: contract.effect,
    idempotent: contract.idempotent,
    irreversible: contract.irreversible,
    riskFloor: contract.riskFloor,
    input: contract.input as JsonObject,
    output: contract.output as JsonObject,
  };
  if (contract.compensate !== undefined) body.compensate = contract.compensate;
  if (contract.completion !== undefined) body.completion = { windowMs: contract.completion.windowMs };
  if (contract.implementation !== undefined) body.implementation = contract.implementation;
  return sha256Digest(body);
}
