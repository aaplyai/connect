/**
 * Plain JSON helpers. They live in `@aaply/action-contract`, which the
 * engine and every action performer share; this module re-exports them so
 * the engine's own imports stay where they were.
 */

export {
  MAX_JSON_DEPTH,
  canonicalJson,
  checkJson,
  cloneJson,
  formatPath,
  getPath,
  hasOwn,
  isJsonObject,
  isJsonValue,
  jsonPointer,
  jsonByteLength,
  jsonEqual,
  own,
  utf8Length,
  type JsonCheckIssue,
  type JsonObject,
  type JsonPrimitive,
  type JsonValue,
  type PathSegment,
} from "@aaply/action-contract";
