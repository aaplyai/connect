/**
 * The JSON Schema subset. It lives in `@aaply/action-contract`, so "valid"
 * means the same at dispatch and at the performer; this module re-exports it
 * so the engine's own imports stay where they were.
 */

export { MAX_PATTERN_LENGTH, MAX_PATTERN_SUBJECT, assignabilityProblems, checkFormat, checkPattern, checkSchema, dateMs, dateTimeMs, describeType, isAssignable, timestampMs, validateValue, type JsonSchema, type JsonType, type SchemaIssue, type StringFormat } from "@aaply/action-contract";
export { MAX_PATTERN_STATES } from "@aaply/action-contract/internal";
