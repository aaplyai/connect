/**
 * Discovery: the flows a person may be offered, as goals.
 *
 * The catalog lists published flows (`FlowCatalog.list`), and may list a
 * flow with `startRoles` for a viewer who holds one of them. Whatever it
 * lists, only what the viewer may start becomes a goal: each listed flow is
 * read with `get`, and is left out when another flow alone may call it
 * (`interface.callableOnly`) or when the viewer holds none of its start roles,
 * on the version listed and on the current version (as `start` checks both).
 * So a catalog that lists every flow for everyone leaks no staff flow's title
 * to a person's decider, exact names or offers.
 */

import type { CompiledFlow } from "./compile.js";
import type { DecisionGoal } from "./decision.js";
import type { CatalogViewer, FlowCatalog } from "./ports.js";
import type { Scope } from "./state.js";

/** Whether a viewer holding `appRoles` may start `flow`: it names no start roles, or the viewer holds one of them. */
export function mayStart(flow: CompiledFlow, appRoles: readonly string[]): boolean {
  return flow.startRoles.length === 0 || appRoles.some((role) => flow.startRoles.includes(role));
}

/** Whether `flow` may be offered to the viewer: they may start it, and it is not only for other flows to call. */
function offerable(flow: CompiledFlow, viewer: CatalogViewer): boolean {
  return flow.interface?.callableOnly !== true && mayStart(flow, viewer.appRoles);
}

/**
 * The goals the catalog offers `viewer` in `scope`: its `list` (asked with the
 * viewer), filtered as the module says. A listed flow that cannot be read is
 * left out. The catalog's own errors propagate.
 */
export async function listGoals(catalog: FlowCatalog, scope: Scope, viewer: CatalogViewer): Promise<DecisionGoal[]> {
  const listed = await catalog.list(scope, { appRoles: [...viewer.appRoles] });
  const kept = await Promise.all(
    listed.map(async (g) => {
      const current = await catalog.get(scope, g.flowId).catch(() => null);
      const flow = current !== null && current.version === g.version ? current : await catalog.get(scope, g.flowId, g.version).catch(() => null);
      if (flow === null || !offerable(flow, viewer)) return false;
      // Starting opens the current version: a viewer who may not start that one is not offered the flow.
      return current === null || current === flow || offerable(current, viewer);
    }),
  );
  return listed
    .filter((_, i) => kept[i])
    .map((g) => ({
      flowId: g.flowId,
      version: g.version,
      title: g.title,
      ...(g.description !== undefined ? { description: g.description } : {}),
      ...(g.phrases ? { phrases: g.phrases } : {}),
      ...(g.names ? { names: g.names } : {}),
    }));
}
