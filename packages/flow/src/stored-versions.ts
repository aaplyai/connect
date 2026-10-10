/**
 * The versions of what a store keeps, and the one check made on reading.
 *
 * The engine is pre-1.0 and promises no compatibility (ADR 0015): there is
 * one current version of every stored value, and nothing older is upgraded.
 * The version fields stay in stored data so an engine refuses a value it
 * does not know (one written by a newer engine) instead of misreading it.
 * The core refuses an unknown event or run state version itself
 * (`flow/event-version`, `flow/state-version`); workspaces are checked here,
 * as the runtime loads them.
 */

import { FlowError } from "./errors.js";
import { isJsonObject, type JsonValue } from "./json.js";
import type { FlowEvent } from "./state.js";
import type { RunStore, WorkspaceState } from "./store.js";

/** The workspace format (`WorkspaceState.v`). */
export const WORKSPACE_VERSION = 2 as const;

/**
 * A stored event as the core reads it: any object, its version left for the
 * core to check. Throws when it is not an object at all.
 */
export function readStoredEvent(raw: unknown): FlowEvent {
  if (!isJsonObject(raw as JsonValue)) throw new Error("a stored event must be an object");
  return raw as FlowEvent;
}

/** A stored workspace, refused unless it is at `WORKSPACE_VERSION`. */
export function checkWorkspace(ws: WorkspaceState): WorkspaceState {
  if ((ws as { v?: unknown }).v !== WORKSPACE_VERSION) throw new FlowError("unavailable", `unsupported workspace version ${String((ws as { v?: unknown }).v)}`);
  return ws;
}

/** The same store, with every workspace it loads checked by {@link checkWorkspace} (the runtime reads its store through this). */
export function versionCheckedStore<S extends RunStore>(store: S): S {
  return new Proxy(store, {
    get(target, prop) {
      if (prop === "loadWorkspace") {
        return async (...args: Parameters<RunStore["loadWorkspace"]>) => {
          const ws = await target.loadWorkspace(...args);
          return ws === null ? null : checkWorkspace(ws);
        };
      }
      if (prop === "listWorkspacesByOwner") {
        return async (...args: Parameters<RunStore["listWorkspacesByOwner"]>) => (await target.listWorkspacesByOwner(...args)).map(checkWorkspace);
      }
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}
