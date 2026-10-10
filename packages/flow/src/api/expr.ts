/**
 * `@aaply/flow/expr`: the expression language. `parseExpr` checks a JSON
 * expression tree, `evaluate` evaluates one, `textToExpr` reads Facet's text
 * form, and `nodeChildren` walks a tree; with the environment names, the
 * operators and the limits.
 */

export { MAX_EXPR_TEXT, textToExpr, type TextResult } from "../expr-text.js";
export { ENV_NAMES, EXPR_OPERATORS, MAX_EXPR_DEPTH, MAX_EXPR_NODES, nodeChildren, parseExpr, type EnvName, type ExprScope, type ListOp, type Node, type ParseOptions, type Reads } from "../expr.js";
export { evaluate, MAX_BUILT_SIZE, MAX_LIST_WORK, type EvalEnv, type Evaluated, type Missing, type Read } from "../expr-eval.js";
