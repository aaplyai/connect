/**
 * `@aaply/flow/definition`: the definition format's tables for tools that
 * read or write definitions: the key table (`DEFINITION_KEYS`, `keysOf`),
 * the name patterns (`NAME_RE`, `FLOW_ID_RE`, ...), the limits, the reply
 * kinds and view keys, fill modes, fact and item addresses, the compiled
 * shapes the main entry does not name, and `validateFlow`.
 */

export { itemOfKey, keyOf, nameOfKey, templateOf } from "../address.js";
export { DEFAULT_MAX_CALL_DEPTH, MAX_CALL_DEPTH, MAX_CALL_OUTPUT_BYTES, MAX_CONTRIBUTORS } from "../calls.js";
export {
  COLLECTION_LIMIT_CEILINGS,
  COLLECTION_LIMITS,
  MAX_COLLECTION_ITEMS,
  MAX_COLLECTIONS,
  MAX_FAN_OUT,
  MAX_FOR_EACH_STEPS,
  MAX_INFLIGHT,
  MAX_ITEM_FIELDS,
  MAX_ITEM_OPS,
  type CompiledCollection,
} from "../collections-compile.js";
export {
  actionNode,
  CALL_END_RULES,
  CONNECTOR_ACTION_RE,
  CONTRACT_DIGEST_RE,
  DEFAULT_ACTION_TIMEOUT_MS,
  DEFAULT_LIMITS,
  DEFAULT_RETRY,
  DEVICE_CAPABILITY_RE,
  EVENT_RE,
  factNode,
  FLOW_ID_RE,
  MAX_ACTIONS,
  MAX_DEFINITION_BYTES,
  MAX_FACTS,
  MAX_RULES_PER_STEP,
  MAX_STEPS,
  NAME_RE,
  OUTPUT_RE,
  ROLE_RE,
  SECTION_RE,
  validateFlow,
  VERSION_RE,
  type CompiledCall,
  type CompiledCallStep,
  type CompiledInterface,
  type CompiledRule,
  type NodeEntries,
} from "../compile.js";
export { DEFINITION_KEYS, keysOf, type DefinitionKeyShapes, type DefinitionObject, type KeyInfo } from "../definition-keys.js";
export { MAX_GOAL_NAME_LENGTH, MAX_GOAL_NAMES } from "../exact.js";
export { FILL_MODES, fillModeOf } from "../fill.js";
export { MAX_INCLUDE_DEPTH, MAX_INCLUDE_PREFIX, MAX_INCLUDES, type IncludeRecord, type PublishSourceOptions } from "../include.js";
export { isReplyViewKey, MAX_REPLY_BLOCKS, MAX_REPLY_BYTES, parseReplyContent, REPLY_KINDS, REPLY_VIEW_KEYS } from "../reply.js";
export type { FillMode } from "../state.js";
