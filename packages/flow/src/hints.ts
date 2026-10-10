/**
 * Hints for compile diagnostics: the mechanical fix for a code, where the
 * fix does not depend on the instance. `compileFlow`, `expandFlow`,
 * `checkFlowCalls` and the memory catalog's `check` and `publish` add them; a code
 * without an entry gets no hint, since its fix depends on what the author
 * meant or is already in the message (`flow/invalid-field`,
 * `flow/invalid-shape`, `flow/expr-invalid`, `flow/too-large`): a vague hint
 * is worse than none for a tool that follows it.
 */

import type { Diagnostic } from "./diagnostics.js";

/** The mechanical fix for each compile code that has one, by code. */
export const FLOW_HINTS: Readonly<Record<string, string>> = Object.freeze({
  // Shape and naming.
  "flow/not-json": "Pass plain JSON: no functions, class instances, undefined, NaN, Infinity or cycles.",
  "flow/unknown-field": "Remove the key or correct its spelling; keep data of your own under an `x-` key.",
  "flow/schema-version": "Set `schemaVersion` to 3 (a fragment declares 1).",
  "flow/invalid-id": "Use lowercase letters, digits and dashes, starting with a letter.",
  "flow/invalid-version": "Use 1 to 32 letters, digits, dots, plus signs or dashes.",
  "flow/invalid-name": "Use letters, digits and underscores, starting with a letter.",
  "flow/duplicate-step": "Give each step an id of its own.",
  "flow/invalid-action-id": "Name a connector action as `connector.operation`, such as `calendar.findSlots`.",
  "flow/invalid-section": "Reference the section with its version, such as `option-list@4`.",
  "flow/section-unversioned": "Pin the section: `name@version`, such as `option-list@4`.",
  "flow/invalid-event": "Name the event as lowercase words joined by dots, such as `payment.completed`.",
  "flow/invalid-limit": "Give the limit a whole number from 1 up to its ceiling.",
  // References and filling.
  "flow/unknown-fact": "Declare it under `facts` (or a list under `collections`), or correct the name.",
  "flow/unknown-action": "Declare it under `actions`, or correct the name.",
  "flow/unfillable-fact": "Let a rule `set` it (or `add` to the list), list it in `entry`, or give it `derive`.",
  "flow/fill-not-set": "Remove the fact from `fills`, or add a rule in this step that sets it.",
  "flow/derived-fact-set": "Stop setting it (a derived fact follows its `derive`), or remove `derive` so it can be given.",
  "flow/derived-fact-flags": "Remove `userAsserted`, `confirm`, `optional` and `parameter` from the derived fact or field.",
  "flow/decline-required": "Mark the fact or field `optional: true`, or stop declining it.",
  "flow/dependency-cycle": "Derive one of these facts from something outside the cycle.",
  "flow/step-never-completes": "Let the step fill a fact (a rule that sets one) or run an action.",
  // Actions.
  "flow/write-needs-undo": "Give the write exactly one of `compensate` (the action that undoes it) or `irreversible: true`.",
  "flow/hold-needs-compensate": "Give the hold `compensate`: the action that releases it.",
  "flow/read-with-write-option": "Remove `compensate`, `reconcile`, `irreversible`, `commit` and `hold` from the read and leave its `risk` at `none`, or declare it `effect: \"write\"`.",
  "flow/action-run-twice": "Run the action from one step; declare a second action for the other step.",
  "flow/approval-roles": "Give a `risk: \"approval\"` action `approval.roles`, and remove `approval` from any other action.",
  "flow/confirm-missing": "Give the step a `view` and a rule with `confirm: true`.",
  // Rules and steps.
  "flow/rules-without-view": "Give the step a `view`, or remove its rules.",
  "flow/rule-needs-run": "Remove `confirm` or `retry` from the rule, or let the step run an action.",
  "flow/wait-rules": "Give the wait step a rule named after its `event` (and `timeout` if it has one), and no others without a view.",
  "flow/call-rules": "Give the call step a `completed` rule that maps the child's output; without a view, only end rules.",
  "flow/secret-exposed": "Leave the secret out of views, end inputs and replies, or set it only into facts with `sensitivity: \"secret\"`.",
  "flow/call-sensitivity": "Pass a secret only between facts with `sensitivity: \"secret\"` on both sides.",
  "flow/secret-correlate": "Correlate the wait on a value that is not secret, such as a reference the action returned beside the secret.",
  // Expressions.
  "flow/expr-unknown-operator": "Use an operator the expression language has; see Expressions in the authoring guide.",
  // Lists.
  "flow/collection-invalid": "Give the list `max` (at least `min`), at least one field, no field named `id`, and a name no fact has.",
  "flow/collection-path": "Read a list as a whole, or one item through `forEach` or a list operation, never by position or path.",
  "flow/items-view-only": "Read `items` only in a view or an end input.",
  "flow/foreach-invalid": "Name a declared list in `forEach`, and let the per-item step change only its own item, without waiting.",
  "flow/item-target": "Let each rule act on items of one list and name the item it changes (`item`, `add`, or its per-item step); keep item fields in `entry`, `needs` and `fills` to their per-item step.",
  "flow/fan-out": "Put `fanOut` (1 up to its ceiling) only on a per-item step (`forEach`) that runs an action and shows no view.",
  // Calls and includes.
  "flow/call-unpinned": "Pin the child: `call.flow` as `id@version`.",
  "flow/call-invalid-ref": "Write `call.flow` as `id@version`.",
  "flow/include-unexpanded": "Expand includes first (`expandFlow`), or publish with `publishSource`.",
  "flow/include-unpinned": "Pin the fragment: `id@version`.",
  // Publishing.
  "flow/version-exists": "Publish the change under a new version: a published version never changes.",
  // Arithmetic.
  "flow/arithmetic-into-write":
    "Do not compute amounts in the flow: pass the host's figure through (integer minor units, such as cents), or let the operation price the rows it is sent.",
});

/** `diagnostics` with each code's hint added where it has one and the diagnostic carries none. */
export function withHints(diagnostics: Diagnostic[]): Diagnostic[] {
  return diagnostics.map((d) => {
    const hint = d.hint === undefined && Object.prototype.hasOwnProperty.call(FLOW_HINTS, d.code) ? FLOW_HINTS[d.code] : undefined;
    return hint !== undefined ? { ...d, hint } : d;
  });
}
