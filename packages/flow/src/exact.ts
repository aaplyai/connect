/**
 * Exact matching: the deterministic first stage of routing free text.
 *
 * A person who types the published name of a flow gets that flow, with no
 * model involved (FacetJS ADR-0046). Text and names are compared after the
 * same normalisation: Unicode NFKC (so full-width letters and digits match
 * their plain forms), locale-free case folding (so "STRASSE" matches
 * "Straße" and a final sigma matches a medial one), trimmed, inner
 * whitespace collapsed and one trailing `.`, `!` or `?` dropped. A name two flows share
 * never matches either of them: an ambiguous name is not exact.
 *
 * The same normalisation answers an open question deterministically: a digit
 * or an option's exact title picks from an offer, and the tenant's `affirm`
 * and `deny` words answer a yes-or-no question. Nothing else does; a model
 * never picks or consents for a person.
 */

import type { Diagnostic } from "./diagnostics.js";

/** Most names one flow may declare in `goal.names`. */
export const MAX_GOAL_NAMES = 10;
/** Longest name in `goal.names`, in characters. */
export const MAX_GOAL_NAME_LENGTH = 80;

/**
 * The form names and text are compared in. Case is folded by upper-casing
 * and then lower-casing (full, locale-free folding: "ß" becomes "ss", "ς"
 * becomes "σ"), and NFKC is applied again since folding can decompose. The
 * fold is repeated until it changes nothing, so it is the same for every
 * spelling of a letter: one round takes "ẞ" only to "ß", a second to "ss".
 * Exactly one trailing mark is dropped, so "help??" is "help?".
 */
export function normaliseName(text: string): string {
  let s = foldCase(text.normalize("NFKC"));
  for (let round = 0; round < 4; round++) {
    const again = foldCase(s);
    if (again === s) break;
    s = again;
  }
  s = s.trim().replace(/\s+/gu, " ");
  if (/[.!?]$/u.test(s)) s = s.slice(0, -1).trimEnd();
  return s;
}

function foldCase(text: string): string {
  return text.toUpperCase().toLowerCase().normalize("NFKC");
}

/** A goal as exact matching needs it. */
export interface NamedGoal {
  flowId: string;
  title: string;
  names?: readonly string[];
}

/**
 * The one goal whose title or one of whose names equals the text, or null
 * when none does or more than one does.
 */
export function matchGoalName(text: string, goals: readonly NamedGoal[]): string | null {
  const wanted = normaliseName(text);
  if (wanted === "") return null;
  const found = new Set<string>();
  for (const goal of goals) {
    for (const name of [goal.title, ...(goal.names ?? [])]) {
      if (normaliseName(name) === wanted) found.add(goal.flowId);
    }
  }
  return found.size === 1 ? [...found][0]! : null;
}

/**
 * The index of the option the text picks: a digit from 1 to the number of
 * options (at most 5), or an option's exact title when no other option has
 * the same title. Null otherwise.
 */
export function matchOption(text: string, options: ReadonlyArray<{ title: string }>): number | null {
  const wanted = normaliseName(text);
  if (/^[1-5]$/u.test(wanted)) {
    const index = Number(wanted) - 1;
    return index < options.length ? index : null;
  }
  const hits = options.flatMap((o, i) => (normaliseName(o.title) === wanted ? [i] : []));
  return hits.length === 1 ? hits[0]! : null;
}

/** Whether the text is exactly one of `words`. */
export function matchWord(text: string, words: readonly string[]): boolean {
  const wanted = normaliseName(text);
  return wanted !== "" && words.some((w) => normaliseName(w) === wanted);
}

/**
 * Checks a catalog's goals for routing: `flow/goal-name-collision` (warning)
 * where two flows answer to the same name, so neither is matched exactly,
 * and `flow/goal-sparse` (warning) for a flow with no description, phrases
 * or names, which a classifier only knows by its title.
 */
export function checkGoals(list: ReadonlyArray<NamedGoal & { description?: string; phrases?: readonly string[] }>): Diagnostic[] {
  const out: Diagnostic[] = [];
  const owners = new Map<string, Set<string>>();
  for (const goal of list) {
    for (const name of [goal.title, ...(goal.names ?? [])]) {
      const key = normaliseName(name);
      if (key === "") continue;
      let set = owners.get(key);
      if (!set) owners.set(key, (set = new Set()));
      set.add(goal.flowId);
    }
    if (!goal.description && !(goal.phrases && goal.phrases.length > 0) && !(goal.names && goal.names.length > 0)) {
      out.push({ code: "flow/goal-sparse", severity: "warning", path: goal.flowId, message: `"${goal.flowId}" has no goal description, phrases or names, so a classifier knows it only by its title` });
    }
  }
  for (const [name, flows] of owners) {
    if (flows.size < 2) continue;
    const ids = [...flows].sort();
    out.push({
      code: "flow/goal-name-collision",
      severity: "warning",
      path: ids.join(","),
      message: `${ids.map((id) => `"${id}"`).join(" and ")} both answer to "${name}", so typing it opens neither`,
    });
  }
  return out;
}
