/**
 * Normalising a decider's proposed values (ADR 0012, "How a proposal says how
 * the model knows").
 *
 * A model proposes `"tomorrow 5pm"` or `"two lakh"`; a fact wants an ISO
 * date-time or an integer. This module turns the common English spoken and
 * written forms into the schema's form, against the run's clock and zone,
 * and refuses everything else. It is deliberately small and literal: a value
 * it cannot read for certain is `unparsed` or `ambiguous`, so the reply asks
 * rather than the engine guessing. It also checks a proposal's quote, which
 * is what lets a value count as `stated`.
 *
 * Everything here is pure: the clock and zone come in on the context, and
 * dates are built from numbers, never parsed from free strings by `Date`.
 */

import type { JsonSchema } from "../schema.js";
import type { JsonValue } from "../json.js";
import type { ZoneSource } from "./zone.js";
import { dateMs, dateTimeMs, checkFormat, validateValue } from "../schema.js";
import { jsonEqual } from "../json.js";
import { localParts, offsetOf, zonedWallTime } from "./zone.js";

/** What a normaliser reads relative values against: the run's clock, zone (and where the zone came from) and locale. */
export interface NormaliseContext {
  now: number;
  timezone: string;
  zoneSource: ZoneSource;
  locale: string;
  /**
   * A host's own reader, tried before the built-in one (other languages,
   * "kal shaam 5 baje"). It returns a result, or `undefined` to fall through
   * to the built-in reader; a throw also falls through. It must be pure: it
   * runs in the runtime, before anything is recorded, and the event records
   * only its result. Whatever it returns is still checked against the schema.
   */
  custom?: (raw: JsonValue, schema: JsonSchema, ctx: NormaliseContext) => Normalised | undefined;
}

/** A normalised value, or why there is none. */
export type Normalised =
  | {
      ok: true;
      value: JsonValue;
      /** The words named a day relative to now (today, tomorrow, a weekday, in 3 days). */
      relative: boolean;
    }
  | { ok: false; reason: "unparsed" | "ambiguous" | "invalid"; message: string };

const MAX_QUOTE = 200;
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Words

const FILLER = new Set(["please", "on", "at", "the", "for", "by"]);

const WEEKDAYS: Record<string, number> = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

const MONTHS: Record<string, number> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5, june: 6, jun: 6,
  july: 7, jul: 7, august: 8, aug: 8, september: 9, sep: 9, sept: 9, october: 10, oct: 10,
  november: 11, nov: 11, december: 12, dec: 12,
};
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const SMALL: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const SCALES: Record<string, number> = { thousand: 1_000, lakh: 100_000, lakhs: 100_000, lac: 100_000, crore: 10_000_000, crores: 10_000_000 };

const DIGIT_WORDS: Record<string, string> = {
  zero: "0", oh: "0", o: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9",
};

// ---------------------------------------------------------------------------
// Small helpers

const fail = (reason: "unparsed" | "ambiguous" | "invalid", message: string): Normalised => ({ ok: false, reason, message });
const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysIn(y: number, m: number): number {
  return [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1] ?? 0;
}

function validYmd(y: number, m: number, d: number): boolean {
  return Number.isInteger(y) && y >= 1 && y <= 9999 && m >= 1 && m <= 12 && d >= 1 && d <= daysIn(y, m);
}

interface Ymd {
  y: number;
  m: number;
  d: number;
}

/** The civil date `n` days after (or before) a civil date, by numbers. */
function addDays(date: Ymd, n: number): Ymd {
  const t = new Date(Date.UTC(date.y, date.m - 1, date.d) + n * DAY_MS);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

const ymdString = (date: Ymd): string => `${pad(date.y, 4)}-${pad(date.m)}-${pad(date.d)}`;
const spoken = (date: Pick<Ymd, "m" | "d">): string => `${date.d} ${MONTH_NAMES[date.m - 1] ?? "?"}`;

/** Lower case, curly quotes and dashes folded, whitespace collapsed. */
function fold(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/** The words of a phrase: folded, light punctuation dropped, a token's trailing full stop dropped, filler removed. */
function words(text: string): string[] {
  return fold(text)
    .replace(/[,!?;"()]/g, " ")
    .split(" ")
    .map((w) => w.replace(/\.$/, ""))
    .filter((w) => w !== "" && !FILLER.has(w));
}

/** The region of a BCP 47 locale (`IN` for `en-IN`), or undefined when it names none. */
function regionOf(locale: string): string | undefined {
  try {
    return new Intl.Locale(locale.replace(/_/g, "-")).region;
  } catch {
    return undefined;
  }
}

function schemaTypes(schema: JsonSchema): string[] {
  return schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
}

// ---------------------------------------------------------------------------
// Dates

type Part<T> = { kind: "ok"; value: T; relative: boolean } | { kind: "ambiguous" | "invalid"; message: string } | null;

function today(ctx: NormaliseContext): Ymd & { weekday: number } {
  const p = localParts(ctx.now, ctx.timezone);
  return { y: p.year, m: p.month, d: p.day, weekday: p.weekday };
}

/** A day and month without a year: the next occurrence on or after today (29 February: the next leap year's). */
function nextOccurrence(m: number, d: number, now: Ymd): Ymd | null {
  if (m < 1 || m > 12 || d < 1 || d > daysIn(2000, m)) return null;
  let y = m < now.m || (m === now.m && d < now.d) ? now.y + 1 : now.y;
  while (!validYmd(y, m, d)) y++;
  return { y, m, d };
}

function explicitDate(d: number, m: number, year: number | undefined, heard: string, now: Ymd): Part<Ymd> {
  if (year === undefined) {
    const next = nextOccurrence(m, d, now);
    return next ? { kind: "ok", value: next, relative: false } : { kind: "invalid", message: `"${heard}" is not a date: ${MONTH_NAMES[m - 1] ?? "that month"} has no day ${d}` };
  }
  return validYmd(year, m, d)
    ? { kind: "ok", value: { y: year, m, d }, relative: false }
    : { kind: "invalid", message: `"${heard}" is not a date: ${MONTH_NAMES[m - 1] ?? "that month"} ${year} has no day ${d}` };
}

const DAY_RE = /^(\d{1,2})(?:st|nd|rd|th)?$/;
const YEAR_RE = /^\d{4}$/;
const NUMERIC_DATE_RE = /^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2}|\d{4}))?$/;
const ISO_DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A date phrase that is the whole of `tokens`.
 *
 * Weekdays: a bare or `this` weekday is the first occurrence on or after
 * today (so "friday" asked on a Friday is today). `next` is read only when
 * it cannot mean two days: on a Friday "next friday" is a week on, but on a
 * Wednesday it could be the Friday two days on or the one a week after
 * that, so it is ambiguous and the reply asks.
 */
function parseDate(tokens: readonly string[], ctx: NormaliseContext): Part<Ymd> {
  if (tokens.length === 0) return null;
  const now = today(ctx);
  const s = tokens.join(" ");
  const rel = (n: number): Part<Ymd> => ({ kind: "ok", value: addDays(now, n), relative: true });

  if (s === "today" || s === "tonight") return rel(0);
  if (s === "tomorrow" || s === "tmrw" || s === "tmr") return rel(1);
  if (s === "day after tomorrow") return rel(2);
  if (s === "yesterday") return rel(-1);

  const weekday = /^(?:(this|next) )?([a-z]+)$/.exec(s);
  if (weekday && weekday[2] !== undefined && WEEKDAYS[weekday[2]] !== undefined) {
    const target = WEEKDAYS[weekday[2]] ?? 0;
    if (weekday[1] !== "next") return rel((target - now.weekday + 7) % 7);
    const ahead = ((target - now.weekday + 6) % 7) + 1;
    if (ahead < 7) {
      const soon = addDays(now, ahead);
      const later = addDays(now, ahead + 7);
      return { kind: "ambiguous", message: `"${s}" could be ${spoken(soon)} or ${spoken(later)}` };
    }
    return rel(ahead);
  }

  const inN = /^in ([a-z]+|\d{1,3}) (day|days|week|weeks)$/.exec(s);
  if (inN && inN[1] !== undefined && inN[2] !== undefined) {
    const n = inN[1] === "a" ? 1 : /^\d+$/.test(inN[1]) ? Number(inN[1]) : SMALL[inN[1]];
    if (n !== undefined && n >= 1 && (n <= 12 || /^\d+$/.test(inN[1]))) return rel(inN[2].startsWith("week") ? n * 7 : n);
    return null;
  }

  if (tokens.length === 1) {
    const only = tokens[0] ?? "";
    if (ISO_DATE_SHAPE.test(only)) {
      const ms = dateMs(only);
      return ms === null ? { kind: "invalid", message: `"${only}" is not a date` } : { kind: "ok", value: ymdFromIso(only), relative: false };
    }
    const iso = dateTimeMs(only);
    if (iso !== null) {
      const p = localParts(iso, ctx.timezone);
      return { kind: "ok", value: { y: p.year, m: p.month, d: p.day }, relative: false };
    }
    const numeric = NUMERIC_DATE_RE.exec(only);
    if (numeric) return numericDate(numeric, only, now);
  }

  // "9 oct", "9th of october 2026", "october 9", "oct 9th 2026".
  const rest = tokens.filter((t) => t !== "of");
  if (rest.length === 2 || rest.length === 3) {
    const year = rest.length === 3 ? rest[2] : undefined;
    if (year !== undefined && !YEAR_RE.test(year)) return null;
    const [a = "", b = ""] = rest;
    const dayFirst = DAY_RE.exec(a);
    const dayLast = DAY_RE.exec(b);
    if (dayFirst && MONTHS[b] !== undefined) return explicitDate(Number(dayFirst[1]), MONTHS[b] ?? 0, year === undefined ? undefined : Number(year), s, now);
    if (dayLast && MONTHS[a] !== undefined) return explicitDate(Number(dayLast[1]), MONTHS[a] ?? 0, year === undefined ? undefined : Number(year), s, now);
  }
  return null;
}

function ymdFromIso(iso: string): Ymd {
  return { y: Number(iso.slice(0, 4)), m: Number(iso.slice(5, 7)), d: Number(iso.slice(8, 10)) };
}

/**
 * `9/10`, `9-10`, `09/10/2026`: read only when one reading is a date or both
 * readings give the same day. When day-first and month-first are both dates
 * and differ it is ambiguous whatever the locale, because a locale says how
 * the device formats dates, not how this person typed this one. A two-digit
 * year is ambiguous too: it does not say which century.
 */
function numericDate(match: RegExpExecArray, heard: string, now: Ymd): Part<Ymd> {
  const first = Number(match[1]);
  const second = Number(match[2]);
  if (match[3] !== undefined && match[3].length === 2) return { kind: "ambiguous", message: `"${heard}" has a two-digit year; which year?` };
  const year = match[3] === undefined ? undefined : Number(match[3]);
  const read = (d: number, m: number): Ymd | null =>
    year === undefined ? nextOccurrence(m, d, now) : validYmd(year, m, d) ? { y: year, m, d } : null;
  const dayFirst = read(first, second);
  const monthFirst = read(second, first);
  if (dayFirst && monthFirst && ymdString(dayFirst) !== ymdString(monthFirst)) {
    return { kind: "ambiguous", message: `"${heard}" could be ${spoken(dayFirst)} or ${spoken(monthFirst)}` };
  }
  const chosen = dayFirst ?? monthFirst;
  return chosen ? { kind: "ok", value: chosen, relative: false } : { kind: "invalid", message: `"${heard}" is not a date` };
}

// ---------------------------------------------------------------------------
// Times

interface Hm {
  h: number;
  m: number;
  s: number;
}

/**
 * A time phrase that is the whole of `tokens`. A two-digit hour with a colon
 * (`05:30`, `17:00`) is the 24-hour clock; a one-digit hour with no am/pm
 * (`5`, `5:30`) could be morning or evening, and is ambiguous.
 */
function parseTime(tokens: readonly string[]): Part<Hm> {
  if (tokens.length === 0) return null;
  const s = tokens.join(" ");
  if (s === "noon" || s === "midday") return { kind: "ok", value: { h: 12, m: 0, s: 0 }, relative: false };
  if (s === "midnight") return { kind: "ok", value: { h: 0, m: 0, s: 0 }, relative: false };

  const twelve = /^(\d{1,2})(?:[:.](\d{2}))? ?([ap])\.?m\.?$/.exec(s);
  if (twelve) {
    const h = Number(twelve[1]);
    const m = twelve[2] === undefined ? 0 : Number(twelve[2]);
    if (h < 1 || h > 12 || m > 59) return { kind: "invalid", message: `"${s}" is not a time` };
    return { kind: "ok", value: { h: (h % 12) + (twelve[3] === "p" ? 12 : 0), m, s: 0 }, relative: false };
  }

  const clock = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (clock) {
    const [h, m, sec] = [Number(clock[1]), Number(clock[2]), clock[3] === undefined ? 0 : Number(clock[3])];
    if (h > 23 || m > 59 || sec > 59) return { kind: "invalid", message: `"${s}" is not a time` };
    return { kind: "ok", value: { h, m, s: sec }, relative: false };
  }

  const loose = /^(\d)(?:[:.](\d{2}))?$/.exec(s) ?? /^(1[0-2])$/.exec(s);
  if (loose && Number(loose[1]) >= 1) return { kind: "ambiguous", message: `"${s}" could be morning or evening; say am or pm` };
  return null;
}

// ---------------------------------------------------------------------------
// Per format

function normaliseDate(raw: string, ctx: NormaliseContext): Normalised {
  const trimmed = raw.trim();
  if (dateMs(trimmed) !== null) return { ok: true, value: trimmed, relative: false };
  const part = parseDate(words(trimmed), ctx);
  if (part === null) return fail("unparsed", `could not read "${trimmed}" as a date`);
  if (part.kind !== "ok") return fail(part.kind, part.message);
  return { ok: true, value: ymdString(part.value), relative: part.relative };
}

function normaliseTime(raw: string): Normalised {
  const trimmed = raw.trim();
  if (checkFormat("time", trimmed)) return { ok: true, value: trimmed, relative: false };
  const part = parseTime(words(trimmed));
  if (part === null) return fail("unparsed", `could not read "${trimmed}" as a time`);
  if (part.kind !== "ok") return fail(part.kind, part.message);
  return { ok: true, value: `${pad(part.value.h)}:${pad(part.value.m)}`, relative: false };
}

function normaliseDateTime(raw: string, ctx: NormaliseContext): Normalised {
  const trimmed = raw.trim();
  if (dateTimeMs(trimmed) !== null) return { ok: true, value: trimmed, relative: false };
  const tokens = words(trimmed);
  let problem: { reason: "ambiguous" | "invalid"; message: string } | undefined;
  // Every split into a date phrase and a time phrase, in either order.
  for (let k = 1; k < tokens.length; k++) {
    for (const [datePart, timePart] of [
      [tokens.slice(0, k), tokens.slice(k)],
      [tokens.slice(k), tokens.slice(0, k)],
    ] as const) {
      const date = parseDate(datePart, ctx);
      if (date === null) continue;
      const time = parseTime(timePart);
      if (time === null) continue;
      if (date.kind === "ok" && time.kind === "ok") {
        const { y, m, d } = date.value;
        const { epoch, kind } = zonedWallTime({ year: y, month: m, day: d, hour: time.value.h, minute: time.value.m, second: time.value.s }, ctx.timezone);
        // A clock change makes the wall time name no instant or two: ask rather than move it or pick one.
        const when = `${spoken(date.value)} at ${pad(time.value.h)}:${pad(time.value.m)}`;
        if (kind === "gap") return fail("invalid", `${when} does not exist in ${ctx.timezone}: the clocks skip it`);
        if (kind === "overlap") return fail("ambiguous", `${when} happens twice in ${ctx.timezone}: the clocks go back`);
        const p = localParts(epoch, ctx.timezone);
        const value = `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${offsetOf(epoch, ctx.timezone)}`;
        return { ok: true, value, relative: date.relative };
      }
      const bad = date.kind !== "ok" ? date : time.kind !== "ok" ? time : undefined;
      if (bad && (problem === undefined || (problem.reason === "ambiguous" && bad.kind === "invalid"))) {
        problem = { reason: bad.kind, message: bad.message };
      }
    }
  }
  if (problem) return fail(problem.reason, problem.message);
  const dateOnly = parseDate(tokens, ctx);
  if (dateOnly !== null) return dateOnly.kind === "ok" ? fail("ambiguous", `"${trimmed}" names a day but no time`) : fail(dateOnly.kind, dateOnly.message);
  const timeOnly = parseTime(tokens);
  if (timeOnly !== null) return timeOnly.kind === "ok" ? fail("ambiguous", `"${trimmed}" names a time but no day`) : fail(timeOnly.kind, timeOnly.message);
  return fail("unparsed", `could not read "${trimmed}" as a date and time`);
}

const PLAIN_NUMBER = /^[+-]?\d+(?:\.\d+)?$/;
// Western (1,200,000) and Indian (12,00,000) digit grouping.
const GROUPED = /^[+-]?(?:\d{1,3}(?:,\d{3})+|\d{1,2}(?:,\d{2})*,\d{3})(?:\.\d+)?$/;

/** A number from digits, grouped digits or English number words, with `hundred`, `thousand`, `lakh` and `crore`. */
function parseNumber(raw: string): number | null {
  const s = fold(raw);
  if (PLAIN_NUMBER.test(s)) return Number(s);
  if (GROUPED.test(s)) return Number(s.replace(/,/g, ""));
  const tokens = s.replace(/-/g, " ").split(" ").filter((w) => w !== "" && w !== "and");
  if (tokens.length === 0) return null;
  let total = 0;
  let current = 0;
  let lastScale = Infinity;
  let seen = false;
  for (const [i, token] of tokens.entries()) {
    if (token === "a" && i === 0) {
      current = 1;
      seen = true;
    } else if (/^\d+(?:\.\d+)?$/.test(token)) {
      if (current !== 0) return null;
      current = Number(token);
      seen = true;
    } else if (SMALL[token] !== undefined) {
      const n = SMALL[token] ?? 0;
      // A unit may follow a tens word ("twenty five"); a teen may not.
      if (n < 10 ? current % 10 !== 0 : current % 100 !== 0) return null;
      if (seen && current === 0 && n === 0) return null;
      current += n;
      seen = true;
    } else if (TENS[token] !== undefined) {
      if (current % 100 !== 0) return null;
      current += TENS[token] ?? 0;
      seen = true;
    } else if (token === "hundred") {
      if (current <= 0 || current >= 100) return null;
      current *= 100;
    } else if (SCALES[token] !== undefined) {
      const scale = SCALES[token] ?? 1;
      if (current <= 0 || scale >= lastScale) return null;
      total += current * scale;
      current = 0;
      lastScale = scale;
    } else return null;
  }
  if (!seen) return null;
  // "2.5 lakh" is exact in decimal but not in binary; round off the dust.
  return Math.round((total + current) * 1e6) / 1e6;
}

function normaliseNumber(raw: string, integer: boolean): Normalised {
  const n = parseNumber(raw);
  if (n === null || !Number.isFinite(n)) return fail("unparsed", `could not read "${raw.trim()}" as a number`);
  if (integer && !Number.isInteger(n)) return fail("invalid", `heard ${n}, but this needs a whole number`);
  return { ok: true, value: n, relative: false };
}

function normaliseBoolean(raw: string): Normalised {
  const s = fold(raw).replace(/[.!]$/, "");
  if (s === "yes" || s === "y" || s === "true") return { ok: true, value: true, relative: false };
  if (s === "no" || s === "n" || s === "false") return { ok: true, value: false, relative: false };
  return fail("unparsed", `could not read "${raw.trim()}" as yes or no`);
}

function normaliseEmail(raw: string): Normalised {
  let s = raw.trim();
  // Spoken forms only when nothing was typed as an address: a literal
  // "dash" in a typed local part stays.
  if (!s.includes("@")) {
    s = s
      .replace(/\s+at\s+/gi, "@")
      .replace(/\s+dot\s+/gi, ".")
      .replace(/\s*\bunderscore\b\s*/gi, "_")
      .replace(/\s*\b(?:dash|hyphen)\b\s*/gi, "-");
  }
  s = s.replace(/\s+/g, "");
  const at = s.lastIndexOf("@");
  if (at > 0) s = s.slice(0, at) + s.slice(at).toLowerCase();
  if (!checkFormat("email", s)) return fail("invalid", `"${raw.trim()}" is not an email address`);
  return { ok: true, value: s, relative: false };
}

/**
 * A phone number in E.164. Spoken digits, "double"/"triple" and a leading
 * "plus" are read. Without a country code, ten digits take the locale's:
 * +91 for region IN, +1 for US and CA; anywhere else it is asked.
 */
function normalisePhone(raw: string, locale: string): Normalised {
  const tokens = fold(raw).split(/[\s\-.()]+/).filter((t) => t !== "");
  let out = "";
  let repeat = 1;
  for (const token of tokens) {
    if (token === "double" || token === "triple") {
      if (repeat !== 1) return fail("unparsed", `could not read "${raw.trim()}" as a phone number`);
      repeat = token === "double" ? 2 : 3;
      continue;
    }
    let chunk: string;
    if (token === "plus" || token === "+") chunk = "+";
    else if (DIGIT_WORDS[token] !== undefined) chunk = DIGIT_WORDS[token] ?? "";
    else if (/^\+?\d+$/.test(token)) chunk = token;
    else return fail("unparsed", `could not read "${raw.trim()}" as a phone number`);
    if (repeat !== 1) {
      const digit = chunk.replace("+", "")[0];
      if (digit === undefined) return fail("unparsed", `could not read "${raw.trim()}" as a phone number`);
      chunk = digit.repeat(repeat) + chunk.replace("+", "").slice(1);
      repeat = 1;
    }
    out += chunk;
  }
  if (repeat !== 1 || out === "") return fail("unparsed", `could not read "${raw.trim()}" as a phone number`);
  if (out.lastIndexOf("+") > 0) return fail("invalid", `"${raw.trim()}" is not a phone number`);
  if (!out.startsWith("+")) {
    const region = regionOf(locale);
    if (out.length === 10 && region === "IN") out = `+91${out}`;
    else if (out.length === 10 && (region === "US" || region === "CA")) out = `+1${out}`;
    else return fail("ambiguous", `"${raw.trim()}" has no country code; which country code?`);
  }
  if (!checkFormat("phone", out)) return fail("invalid", `"${raw.trim()}" is not a phone number`);
  return { ok: true, value: out, relative: false };
}

// ---------------------------------------------------------------------------
// Entry points

/**
 * Normalises a decider's proposed value for a fact's schema: dates, times
 * and date-times against `ctx.now` in `ctx.timezone`, numbers (digits, words,
 * lakh and crore), yes/no, spoken emails and phone numbers, and whitespace in
 * plain strings. A schema with `enum`, `const` or `anyOf` is left alone
 * except that strings are trimmed. The result must validate against the
 * schema, or it is `invalid` with the first issue's message.
 */
export function normaliseValue(raw: JsonValue, schema: JsonSchema, ctx: NormaliseContext): Normalised {
  const converted = readCustom(raw, schema, ctx) ?? convert(raw, schema, ctx);
  if (!converted.ok) return converted;
  const issue = validateValue(schema, converted.value)[0];
  return issue ? fail("invalid", issue.message) : converted;
}

function readCustom(raw: JsonValue, schema: JsonSchema, ctx: NormaliseContext): Normalised | undefined {
  if (ctx.custom === undefined) return undefined;
  try {
    return ctx.custom(raw, schema, ctx);
  } catch {
    return undefined;
  }
}

const PLAIN_TIME = /^(\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * Whether two values mean the same for a schema: date-times as instants
 * (`2026-10-09T11:30:00Z` is `2026-10-09T17:00:00+05:30`), dates as days,
 * times without an offset as seconds of the day (`17:00` is `17:00:00`), and
 * anything else as JSON.
 */
function sameMeaning(a: JsonValue, b: JsonValue, schema: JsonSchema): boolean {
  if (jsonEqual(a, b)) return true;
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (schema.format === "date-time") {
    const [x, y] = [dateTimeMs(a), dateTimeMs(b)];
    return x !== null && x === y;
  }
  if (schema.format === "date") {
    const [x, y] = [dateMs(a), dateMs(b)];
    return x !== null && x === y;
  }
  if (schema.format === "time") {
    const [x, y] = [PLAIN_TIME.exec(a), PLAIN_TIME.exec(b)];
    const secs = (m: RegExpExecArray): number => (Number(m[1]) * 60 + Number(m[2])) * 60 + Number(m[3] ?? 0);
    return x !== null && y !== null && secs(x) === secs(y);
  }
  return false;
}

function convert(raw: JsonValue, schema: JsonSchema, ctx: NormaliseContext): Normalised {
  const kept: Normalised = { ok: true, value: typeof raw === "string" ? raw.trim() : raw, relative: false };
  if (typeof raw !== "string") return kept;
  if (schema.enum !== undefined || schema.const !== undefined || schema.anyOf !== undefined) return kept;
  switch (schema.format) {
    case "date":
      return normaliseDate(raw, ctx);
    case "time":
      return normaliseTime(raw);
    case "date-time":
      return normaliseDateTime(raw, ctx);
    case "email":
      return normaliseEmail(raw);
    case "phone":
      return normalisePhone(raw, ctx.locale);
    case undefined:
      break;
    default:
      return kept;
  }
  const types = schemaTypes(schema);
  // A schema that also allows a string keeps the string as written.
  if (types.includes("string") || types.length === 0) return { ok: true, value: raw.trim().replace(/\s+/g, " "), relative: false };
  if (types.includes("integer") || types.includes("number")) return normaliseNumber(raw, !types.includes("number"));
  if (types.includes("boolean")) return normaliseBoolean(raw);
  return kept;
}

// Letters, digits and combining marks are token characters, in any script;
// an apostrophe between two of them stays inside the token ("i'm", "don't").
const TOKEN = /[\p{L}\p{N}\p{M}]+(?:'[\p{L}\p{N}\p{M}]+)*/gu;
const TOKEN_CHAR_AT_END = /[\p{L}\p{N}\p{M}]$/u;
const TOKEN_CHAR_AT_START = /^[\p{L}\p{N}\p{M}]/u;

/** Words that turn the choice after them around: "not premium", "don't", "mat". */
const NEGATIONS = new Set(["not", "no", "don't", "dont", "never", "nahi", "mat"]);
const isNegation = (token: string): boolean => NEGATIONS.has(token) || token.endsWith("n't");

/** The tokens of folded text. */
function tokensOf(folded: string): string[] {
  return folded.match(TOKEN) ?? [];
}

/** Where `needle` starts in `haystack` as a contiguous run of whole tokens, or -1. */
function tokenRun(haystack: readonly string[], needle: readonly string[]): number {
  if (needle.length === 0) return -1;
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    if (needle.every((t, k) => haystack[i + k] === t)) return i;
  }
  return -1;
}

/**
 * The places folded `q` appears in folded `t` on whole-token boundaries: a
 * token character at the quote's edge must not continue a token of the text
 * ("5" is not in "15", "no" is not in "not"). Each place carries the text's
 * token just before it.
 */
function placements(q: string, t: string): { before: string | undefined }[] {
  const out: { before: string | undefined }[] = [];
  const startsWord = TOKEN_CHAR_AT_START.test(q);
  const endsWord = TOKEN_CHAR_AT_END.test(q);
  for (let at = t.indexOf(q); at !== -1; at = t.indexOf(q, at + 1)) {
    const head = t.slice(0, at);
    if (startsWord && TOKEN_CHAR_AT_END.test(head)) continue;
    if (endsWord && TOKEN_CHAR_AT_START.test(t.slice(at + q.length))) continue;
    out.push({ before: tokensOf(head).at(-1) });
  }
  return out;
}

/**
 * Whether a proposal's quote supports its value. The quote is a non-empty
 * string of at most 200 characters that appears in the person's text on
 * whole-token boundaries (case, whitespace, curly quotes and dashes folded;
 * letters and digits of any script are token characters), and either
 * normalising it for the schema gives `value` (date-times compared as
 * instants, dates as days, times as times of day), or, for a plain string
 * or an enum, the value's tokens appear as whole tokens, in order, in the
 * quote. A choice (an enum or a boolean) is refused when a negation ("not",
 * "no", "don't", "never", "nahi", "mat") comes before it inside the quote or
 * just before the quote in the text. Date-times are strict: a quote that
 * gives only the day does not support a full date-time.
 */
export function quoteSupports(quote: unknown, text: string, value: JsonValue, schema: JsonSchema, ctx: NormaliseContext): boolean {
  if (typeof quote !== "string" || quote.length > MAX_QUOTE) return false;
  const q = fold(quote);
  if (q === "") return false;
  const choice = schema.enum !== undefined || typeof value === "boolean";
  const places = placements(q, fold(text));
  if (!places.some((p) => !choice || p.before === undefined || !isNegation(p.before))) return false;
  const qTokens = tokensOf(q);
  const normalised = normaliseValue(quote, schema, ctx);
  if (normalised.ok && sameMeaning(normalised.value, value, schema)) return true;
  if (typeof value !== "string") return false;
  const vTokens = tokensOf(fold(value));
  const at = tokenRun(qTokens, vTokens);
  if (at === -1) return false;
  if (schema.enum !== undefined) return !qTokens.slice(0, at).some(isNegation);
  return schema.format === undefined && schema.const === undefined && schema.anyOf === undefined && schemaTypes(schema).includes("string");
}

/**
 * Whether a quote names a day relative to now ("tomorrow 5pm", "friday"),
 * read for the fact's schema. A model that resolves "tomorrow" to an ISO
 * value itself still quoted "tomorrow", so the near-midnight ask reads the
 * quote as well as the value. For a date-time fact a quote that names only
 * the day counts too.
 */
export function quoteIsRelative(quote: unknown, schema: JsonSchema, ctx: NormaliseContext): boolean {
  if (typeof quote !== "string" || quote.length > MAX_QUOTE) return false;
  const normalised = normaliseValue(quote, schema, ctx);
  if (normalised.ok) return normalised.relative;
  if (schema.format !== "date-time") return false;
  const day = normaliseDate(quote, ctx);
  return day.ok && day.relative;
}

/**
 * Whether a relative day must be asked about rather than filled: the zone
 * came from a fallback (not the person's context) and it is within three
 * hours of midnight there, so "tomorrow" may mean a different day to them.
 */
export function nearMidnight(ctx: NormaliseContext): boolean {
  if (ctx.zoneSource === "context") return false;
  const { hour } = localParts(ctx.now, ctx.timezone);
  return hour >= 21 || hour < 3;
}
