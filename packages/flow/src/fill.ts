/**
 * The fill policy's modes (ADR 0012): how far a model's value may go
 * without the person. Shared by facts (core.ts), item fields (core-items.ts),
 * the compiler and the runtime's cap.
 */

import type { FactDef } from "./definition.js";
import type { FactState, FillMode } from "./state.js";

/** Fill modes, tightest first (ADR 0012). Frozen: the compiler reads it. */
export const FILL_MODES: readonly FillMode[] = Object.freeze(["never", "suggest", "confirm", "auto"]);

/** The tighter of two modes; an absent one does not count. */
export function tighterMode(a: FillMode | undefined, b: FillMode | undefined): FillMode | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return FILL_MODES.indexOf(a) <= FILL_MODES.indexOf(b) ? a : b;
}

/**
 * How far a model's value for a fact or item field may go (ADR 0012): the
 * tighter of the definition's mode (default `confirm`; `never` for
 * `userAsserted` facts) and the tenant's cap.
 */
export function fillModeOf(fact: { def: Pick<FactDef, "userAsserted" | "fill" | "confirm"> }, cap?: FillMode): FillMode {
  const own: FillMode = fact.def.userAsserted ? "never" : (fact.def.fill ?? "confirm");
  const capped = cap !== undefined && FILL_MODES.indexOf(cap) >= 0 && FILL_MODES.indexOf(cap) < FILL_MODES.indexOf(own) ? cap : own;
  // `confirm: true` keeps a fact from going further than confirm, whatever it says.
  return fact.def.confirm && capped === "auto" ? "confirm" : capped;
}

/** A value the person gave, or chose to decline: the assistant may suggest over it, never write. */
export function personOwned(st: FactState | undefined): boolean {
  if (!st) return false;
  if (st.status === "declined") return true;
  return (st.provenance === "user" || st.provenance === "entry") && (st.status === "valid" || st.status === "invalid" || st.status === "needs_confirmation");
}
