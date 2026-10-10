/**
 * `@aaply/action-contract/internal`: helpers this repository's packages share
 * so each question has one answer: freezing exported tables (`deepFreeze`,
 * `fixedPattern`, `frozenSet`, `frozenMap`) and the bounded pattern
 * matcher behind the schema subset's `pattern`. NOT public API: it may change
 * or go away in any release, and only the packages api-surface.test.ts allows
 * may import it.
 */

export { deepFreeze, fixedPattern, frozenMap, frozenSet } from "../frozen.js";
export { compilePattern, MAX_PATTERN_STATES, patternMatches, type CompiledPattern, type PatternBudget } from "../pattern.js";
