/**
 * Exported tables that nothing can change at run time. `Object.freeze`
 * covers objects and arrays; it does not cover a RegExp (`compile` changes
 * what it matches in place, frozen or not) or a Set or Map (`add` and `set`
 * work on a frozen one). So a pattern is exported as a {@link FixedPattern}
 * and a set or a map as a {@link frozenSet} or {@link frozenMap}: each keeps its own RegExp or Set where
 * no caller can reach it.
 */

/** A pattern as data: its source and flags, and a test. Unlike a RegExp, nothing can change what it matches. */
export interface FixedPattern {
  readonly source: string;
  readonly flags: string;
  /** Whether `value` matches. */
  test(value: string): boolean;
}

/** A {@link FixedPattern} of `re`, frozen; a global or sticky flag is dropped, so a test never depends on the one before. */
export function fixedPattern(re: RegExp): FixedPattern {
  const own = new RegExp(re.source, re.flags.replace(/[gy]/g, ""));
  return Object.freeze({ source: own.source, flags: own.flags, test: (value: string): boolean => own.test(value) });
}

/** A read-only, frozen view of a set of `values`: `has`, `size` and iteration, and no way to add or remove one. */
export function frozenSet<T>(values: Iterable<T>): ReadonlySet<T> {
  const own = new Set(values);
  const view: ReadonlySet<T> = Object.freeze({
    get size(): number {
      return own.size;
    },
    has: (value: T): boolean => own.has(value),
    forEach: (callback: (value: T, key: T, set: ReadonlySet<T>) => void, thisArg?: unknown): void => own.forEach((v) => callback.call(thisArg, v, v, view)),
    entries: () => own.entries(),
    keys: () => own.keys(),
    values: () => own.values(),
    [Symbol.iterator]: () => own.values(),
  });
  return view;
}

/** A read-only, frozen view of a map of `entries`: `get`, `has`, `size` and iteration, and no way to set or delete one. */
export function frozenMap<K, V>(entries: Iterable<readonly [K, V]>): ReadonlyMap<K, V> {
  const own = new Map(entries);
  const view: ReadonlyMap<K, V> = Object.freeze({
    get size(): number {
      return own.size;
    },
    get: (key: K): V | undefined => own.get(key),
    has: (key: K): boolean => own.has(key),
    forEach: (callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void => own.forEach((v, k) => callback.call(thisArg, v, k, view)),
    entries: () => own.entries(),
    keys: () => own.keys(),
    values: () => own.values(),
    [Symbol.iterator]: () => own.entries(),
  });
  return view;
}

/** `value`, with every object and array reachable from it frozen. */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}
