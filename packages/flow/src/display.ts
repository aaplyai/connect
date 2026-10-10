/**
 * A value as text a person reads: dates, times and numbers in the run's
 * locale and time zone. Views carry it beside the value (`ViewField.display`),
 * so every channel, a screen or a voice, says a value the same way.
 *
 * Only views use it. Views are not part of a run's events, so a change in
 * the platform's locale data never changes what a replay rebuilds.
 */

import type { JsonValue } from "./json.js";
import type { JsonSchema } from "./schema.js";
import type { RunEnv } from "./state.js";

/** Longest text this returns; a longer one is cut with an ellipsis. */
const MAX_DISPLAY = 500;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)/;

/** `value`, as `schema` describes it, as text in `env`'s locale and time zone. */
export function displayValue(value: JsonValue, schema: JsonSchema, env: Pick<RunEnv, "locale" | "timezone">): string {
  const text = render(value, schema, env, 0);
  return text.length > MAX_DISPLAY ? `${text.slice(0, MAX_DISPLAY - 1)}…` : text;
}

function render(value: JsonValue, schema: JsonSchema, env: Pick<RunEnv, "locale" | "timezone">, depth: number): string {
  if (value === null) return "";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return format(env.locale, (l) => new Intl.NumberFormat(l).format(value)) ?? String(value);
  if (typeof value === "string") {
    if (schema.format === "date") {
      const m = DATE_RE.exec(value);
      if (m) {
        const at = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
        return format(env.locale, (l) => new Intl.DateTimeFormat(l, { dateStyle: "medium", timeZone: "UTC" }).format(at)) ?? value;
      }
    }
    if (schema.format === "date-time") {
      const at = Date.parse(value);
      if (Number.isFinite(at)) return format(env.locale, (l) => new Intl.DateTimeFormat(l, { dateStyle: "medium", timeStyle: "short", timeZone: zoneOr(env.timezone) }).format(at)) ?? value;
    }
    if (schema.format === "time") {
      const m = TIME_RE.exec(value);
      if (m) {
        const at = Date.UTC(2000, 0, 1, Number(m[1]), Number(m[2]));
        return format(env.locale, (l) => new Intl.DateTimeFormat(l, { timeStyle: "short", timeZone: "UTC" }).format(at)) ?? value;
      }
    }
    return value;
  }
  if (depth >= 4) return "…";
  if (Array.isArray(value)) return value.map((v) => render(v, schema.items ?? {}, env, depth + 1)).join(", ");
  return Object.entries(value)
    .map(([k, v]) => `${k}: ${render(v, schema.properties?.[k] ?? {}, env, depth + 1)}`)
    .join(", ");
}

/** Formats with the locale, falling back to English when the platform does not know it. Null when neither works. */
function format(locale: string, make: (locale: string) => string): string | null {
  for (const l of [locale, "en"]) {
    try {
      return make(l);
    } catch {
      // An unknown locale or zone: try the next.
    }
  }
  return null;
}

function zoneOr(timezone: string): string {
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone });
    return timezone;
  } catch {
    return "UTC";
  }
}
