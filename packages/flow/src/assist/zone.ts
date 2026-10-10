/**
 * Time zones for assisted filling: which zone a run uses, and the wall-clock
 * maths a normaliser needs to turn "tomorrow 5pm" into an instant.
 *
 * Only `Intl` is used. A zone is valid when this runtime's `Intl` knows it,
 * so the answer can differ between runtimes with different time-zone data;
 * the run records the zone it chose rather than re-resolving it on replay
 * (ADR 0012).
 */

import type { ZoneSource } from "../state.js";

/** Which candidate supplied a run's zone: the trusted context, the app's policy, the engine's default, or the UTC fallback. */
export type { ZoneSource };

/** Wall-clock parts of an instant in a zone. `month` is 1–12; `weekday` is 0 for Sunday. */
export interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}

const MAX_ZONE_LENGTH = 64;
const MAX_CACHED = 64;
const DAY_MS = 86_400_000;

// Formatters are expensive to build and a run asks the same zone many times.
// The map is bounded so a stream of distinct (valid) names cannot grow it.
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  const cached = formatters.get(timezone);
  if (cached) return cached;
  // `latn` digits, the Gregorian calendar and a 0–23 hour cycle, whatever the
  // runtime's default locale is, so the parts below are always plain numbers.
  const formatter = new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  });
  if (formatters.size >= MAX_CACHED) {
    const oldest = formatters.keys().next();
    if (!oldest.done) formatters.delete(oldest.value);
  }
  formatters.set(timezone, formatter);
  return formatter;
}

/**
 * A real IANA zone name this runtime's `Intl` knows. The name is kept as
 * given (case included); `UTC` is valid. Non-strings, the empty string,
 * names over 64 characters and numeric offsets such as `+05:30` (which newer
 * runtimes accept as a zone but are not IANA names) are not.
 */
export function validZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz.length === 0 || tz.length > MAX_ZONE_LENGTH) return false;
  if (!/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(tz)) return false;
  try {
    formatterFor(tz);
    return true;
  } catch {
    return false;
  }
}

/** The first valid zone of context, app and engine, with the source that supplied it; `UTC` when none is. */
export function resolveZone(candidates: { context?: unknown; app?: unknown; engine?: unknown }): { timezone: string; source: ZoneSource } {
  if (validZone(candidates.context)) return { timezone: candidates.context, source: "context" };
  if (validZone(candidates.app)) return { timezone: candidates.app, source: "app" };
  if (validZone(candidates.engine)) return { timezone: candidates.engine, source: "engine" };
  return { timezone: "UTC", source: "utc" };
}

/** Wall-clock parts of an instant in a zone. */
export function localParts(epochMs: number, timezone: string): LocalParts {
  const parts = formatterFor(timezone).formatToParts(epochMs);
  const read = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value ?? NaN);
  const year = read("year");
  const month = read("month");
  const day = read("day");
  // The weekday comes from the civil date rather than a localised name:
  // day 0 of the epoch, 1970-01-01, was a Thursday.
  const days = Math.floor(Date.UTC(year, month - 1, day) / DAY_MS);
  const weekday = (((days + 4) % 7) + 7) % 7;
  return { year, month, day, hour: read("hour"), minute: read("minute"), second: read("second"), weekday };
}

/** The zone's offset from UTC at an instant, in ms (positive east of Greenwich). */
function offsetMs(epochMs: number, timezone: string): number {
  const p = localParts(epochMs, timezone);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wall - Math.floor(epochMs / 1000) * 1000;
}

/**
 * Where a local wall time falls in a zone: `exact` when it happens once,
 * `gap` when the clocks skip it (spring-forward), `overlap` when it happens
 * twice (fall-back).
 */
export type WallTimeKind = "exact" | "gap" | "overlap";

/**
 * The instant of a local wall time in a zone, and whether that wall time
 * happens once, never (a gap) or twice (an overlap). In a gap the instant is
 * the wall time moved forward by the gap; in an overlap it is the earlier of
 * the two. A caller that must not guess asks when `kind` is not `exact`.
 */
export function zonedWallTime(
  local: { year: number; month: number; day: number; hour: number; minute: number; second?: number },
  timezone: string,
): { epoch: number; kind: WallTimeKind } {
  const wall = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second ?? 0);
  // A zone changes offset at most once within a day either side, so the
  // offsets a day before and a day after are the only two the answer can use.
  const before = offsetMs(wall - DAY_MS, timezone);
  const after = offsetMs(wall + DAY_MS, timezone);
  const fits = [...new Set([wall - before, wall - after])].filter((t) => t + offsetMs(t, timezone) === wall);
  if (fits.length > 1) return { epoch: Math.min(...fits), kind: "overlap" };
  if (fits.length === 1) return { epoch: fits[0] ?? wall - before, kind: "exact" };
  // In a gap: reading the wall time with the offset in force before the
  // change lands after it, on the wall time moved forward by the gap.
  return { epoch: wall - before, kind: "gap" };
}

/**
 * The instant of a local wall time in a zone. A time that does not exist
 * (a spring-forward gap) moves forward by the gap; an ambiguous one (a
 * fall-back hour) takes the earlier instant. `zonedWallTime` says which.
 */
export function zonedEpoch(local: { year: number; month: number; day: number; hour: number; minute: number; second?: number }, timezone: string): number {
  return zonedWallTime(local, timezone).epoch;
}

/** The zone's offset at an instant as `+05:30`, `-04:00` or `+00:00`. */
export function offsetOf(epochMs: number, timezone: string): string {
  const minutes = Math.round(offsetMs(epochMs, timezone) / 60_000);
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}
