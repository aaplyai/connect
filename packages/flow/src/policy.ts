/**
 * The decision policy: how one tenant routes a person's free text.
 *
 * - `mode` says what a model may do: `off` (no text reaches any model: exact
 *   names and open offers and questions still work, free text in an active
 *   flow gets a clarifying reply pointing to its view, and nothing is
 *   extracted; a tenant who wants extraction picks `suggest` or `auto`),
 *   `suggest` (a model fills facts and answers side questions, and close
 *   matches become an offer the person picks from, a parked run included) or
 *   `auto` (a confident match opens the flow or resumes its parked run).
 *   `auto` needs a `calibration` from a passing evaluation run in `auto`;
 *   without one that hangs together the runtime uses `suggest` and records
 *   the downgrade.
 * - No policy at all is `off` (`NO_POLICY`).
 * - Exact published names are matched by the runtime without a model, in
 *   every mode (`exact`, default true).
 * - `stages` and `shadow` choose the decider stages a tenant uses, and which
 *   only run beside the live ones to be recorded.
 *
 * Hosts read the policy per request from the tenant's store, so a change
 * applies at once. A policy that cannot be read or parsed fails closed to
 * `off`.
 *
 * The default thresholds (open at 0.9, suggest at 0.5, margin 0.15) are a
 * vendor's published guidance and are UNVALIDATED: no evaluation chose them.
 */

import { deepFreeze } from "@aaply/action-contract/internal";
import { validZone } from "./assist/zone.js";
import { FILL_MODES, SECTION_RE, type CompiledView } from "./compile.js";
import type { FillMode } from "./state.js";
import { DiagnosticBag, type Diagnostic } from "./diagnostics.js";
import { parseExpr, emptyReads, mergeReads, type Node } from "./expr.js";
import { sha256, toHex } from "./hash.js";
import { isJsonObject, checkJson, canonicalJson, type JsonValue, type PathSegment } from "./json.js";
import { checkReplyScope, isReplyViewKey, REPLY_SCOPES, type ReplyViewKey, type ReplyViews } from "./reply.js";

/** What a model's routing may do for a tenant: nothing (`off`), offer (`suggest`) or open (`auto`). */
export type RoutingMode = "off" | "suggest" | "auto";

/** The confidences a ranked stage decides by. */
export interface DecisionThresholds {
  /** Open (in `auto`) at this confidence or above, when the lead over the runner-up is at least `margin`. */
  openAt: number;
  /** Offer options at this confidence or above. */
  suggestAt: number;
  /** The lead the first label needs over the second to open (or to answer `nomatch`). */
  margin: number;
}

/**
 * A decider stage an `auto` calibration was earned with: its name, its
 * adapter and the models it reported while the evaluation ran.
 */
export interface CalibratedStage {
  name: string;
  adapter?: { id: string; version: string };
  /** Every `usage.model` the stage reported; absent when it reported none. */
  models?: string[];
}

/**
 * What a passing holdout run in `auto` earned (`DecisionReport.calibration`):
 * the report's digest, the thresholds it measured, and the stages that
 * proposed during it. `digest` binds the fields together
 * (`calibrationDigest`), so a calibration edited by hand no longer counts.
 * Only the host, holding the report, can check that it was earned:
 * `verifyCalibration` in `@aaply/flow/eval`.
 */
export interface Calibration {
  /** The holdout report's digest (`DecisionReport.digest`): 64 lower-case hex digits. */
  report: string;
  thresholds: DecisionThresholds;
  /** Always `auto`: a run in `suggest` never exercises the thresholds that open. */
  mode: "auto";
  /**
   * The stages that proposed while the holdout ran, each with its adapter
   * and models; empty for a port that reports no stages. `auto` opens only
   * on a proposal from one of them. Absent: not bound to stages (the
   * evaluation kit's own runs).
   */
  stages?: CalibratedStage[];
  /** SHA-256 (hex) of the other fields' canonical JSON. */
  digest: string;
}

/** Which fact values a decider sees: none, only non-personal ones, or everything but secrets. */
export type ShareValues = "none" | "nonPersonal" | "nonSecret";

/** Texts a tenant may set (for its language). `{flow}`, `{from}` and `{to}` are replaced with flow titles. */
export type TextKey =
  | "nomatch"
  | "clarify"
  | "suggest"
  | "suggestOne"
  | "switch"
  | "cancel"
  | "useOptions"
  | "changed"
  | "offerGone"
  | "pickOne"
  | "nothingToConfirm"
  | "tellMore"
  | "whatNext"
  | "nothingToCancel"
  | "whichOne"
  | "nothingToUndo";

/**
 * One tenant's policy for free text: what a model's routing may do
 * (`mode`), which stages run, the thresholds and their calibration, what a
 * decider sees, and the tenant's wording and reply views. Read per turn and
 * checked with `parseDecisionPolicy`.
 */
export interface DecisionPolicy {
  mode: RoutingMode;
  /** The policy's version, recorded on every turn. */
  version?: string;
  /** The decider stages this tenant may use, in order. Absent: every stage the host configured. */
  stages?: string[];
  /** Stages that run beside the live ones and are only recorded. */
  shadow?: string[];
  /** May a tenant-funded stage hand over to a platform-funded one? Default false. */
  platformFallback?: boolean;
  /** Match exact published names without a model. Default true. */
  exact?: boolean;
  /** Defaults 0.9 / 0.5 / 0.15: UNVALIDATED. */
  thresholds?: Partial<DecisionThresholds>;
  /** Options in an offer, 1 to 5. Default 3. */
  maxOptions?: number;
  /** Longest text a classifier is sent. Default 500. */
  maxRoutingText?: number;
  /** How long an offer stays open. Default 10 minutes. */
  offerTtlMs?: number;
  /** Default `nonSecret`. */
  shareValues?: ShareValues;
  /** Origins (`https://host`) a reply's links may point to. Default none. */
  linkOrigins?: string[];
  /** Reply views for turns that have no active flow, or whose flow names none. */
  replies?: ReplyViews;
  texts?: Partial<Record<TextKey, string>>;
  /** Words that answer yes to an open question (no model involved). */
  affirm?: string[];
  /** Words that answer no. */
  deny?: string[];
  /** Words that undo the assistant's latest fills in the open step (no model involved). Default "undo", "undo that". */
  undo?: string[];
  /**
   * The app's time zone (an IANA name), for runs whose caller gives none or
   * an invalid one (ADR 0012). Admins should set it; without it the engine's
   * `defaultTimezone`, then UTC, is used.
   */
  timezone?: string;
  /**
   * The furthest an assistant's value may go for this tenant (or, in an
   * override, this channel): `never`, `suggest`, `confirm` or `auto`. It only
   * tightens what each fact allows. Default: no cap.
   */
  fill?: FillMode;
  /** What a passing holdout run in `auto` earned (`DecisionReport.calibration`). Needed for `auto`. */
  calibration?: Calibration;
  /** Per channel or locale; the first match wins. */
  overrides?: Array<{ when: { channel?: string; locale?: string }; set: Partial<Omit<DecisionPolicy, "overrides">> }>;
}

/** The policy as it applies to one turn: defaults filled, the override applied, reply views compiled. */
export interface ResolvedPolicy {
  mode: RoutingMode;
  version?: string;
  stages?: string[];
  shadow: string[];
  platformFallback: boolean;
  exact: boolean;
  thresholds: DecisionThresholds;
  maxOptions: number;
  maxRoutingText: number;
  offerTtlMs: number;
  shareValues: ShareValues;
  linkOrigins: string[];
  replies: ReadonlyMap<ReplyViewKey, CompiledView>;
  texts: Readonly<Record<TextKey, string>>;
  affirm: string[];
  deny: string[];
  undo: string[];
  /** The app's time zone, when the policy names one. */
  timezone?: string;
  /** The tenant's (or channel's) cap on assisted fills. */
  fill?: FillMode;
  /**
   * In `auto`: the stages its calibration was earned with. A proposal that
   * would open or resume on its own, from any other stage (or a port that
   * reports none when stages are named), is offered instead. Absent: not
   * bound to stages.
   */
  calibratedStages?: readonly CalibratedStage[];
  /** `auto` was asked for without matching calibration, so this turn runs as `suggest`. */
  downgraded: boolean;
}

/** UNVALIDATED: TypeSafe's published guidance, not chosen by any evaluation. */
export const DEFAULT_THRESHOLDS: Readonly<DecisionThresholds> = Object.freeze({ openAt: 0.9, suggestAt: 0.5, margin: 0.15 });
/** Options in an offer when the policy does not say. */
export const DEFAULT_MAX_OPTIONS = 3;
/** Most options an offer may hold. */
export const MAX_OPTIONS_CAP = 5;
/** Longest text a classifier is sent when the policy does not say. */
export const DEFAULT_MAX_ROUTING_TEXT = 500;
/** How long an offer stays open when the policy does not say. */
export const DEFAULT_OFFER_TTL_MS = 10 * 60 * 1000;

/** The default English texts. */
export const DEFAULT_TEXTS: Readonly<Record<TextKey, string>> = Object.freeze({
  nomatch: "Sorry, I cannot help with that here.",
  clarify: "Sorry, I did not understand. Could you say that another way?",
  suggest: "Did you mean one of these?",
  suggestOne: 'Did you mean "{flow}"?',
  switch: 'Set aside "{from}" and start "{to}"?',
  cancel: 'Cancel "{flow}"?',
  useOptions: "Please use the options shown.",
  changed: "Something changed meanwhile. What would you like to do?",
  offerGone: "Those options are no longer available. What would you like to do?",
  pickOne: "Please pick one of the options.",
  nothingToConfirm: "There is nothing to confirm.",
  tellMore: "Could you tell me a bit more?",
  whatNext: "What would you like to do?",
  nothingToCancel: "There is nothing to cancel.",
  whichOne: "Which one would you like to go back to?",
  nothingToUndo: "There is nothing to undo.",
});

/** Every text a tenant may set. */
export const TEXT_KEYS = deepFreeze(Object.keys(DEFAULT_TEXTS) as TextKey[]);

const DEFAULT_AFFIRM = ["yes", "ok", "okay"];
const DEFAULT_DENY = ["no"];
const DEFAULT_UNDO = ["undo", "undo that"];


/**
 * What a runtime with no `policy` option uses: routing `off`. Exact
 * published names, open offers and questions still work, deterministically;
 * no text reaches a model.
 */
export const NO_POLICY: DecisionPolicy = deepFreeze({ mode: "off" }) as DecisionPolicy;

/** What a policy that cannot be read or parsed becomes: routing off. */
export const FAIL_CLOSED_POLICY: DecisionPolicy = Object.freeze({ mode: "off" }) as DecisionPolicy;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const MODES: readonly RoutingMode[] = ["off", "suggest", "auto"];
const STAGE_NAME = /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/;
const POLICY_KEYS = [
  "mode",
  "version",
  "stages",
  "shadow",
  "platformFallback",
  "exact",
  "thresholds",
  "maxOptions",
  "maxRoutingText",
  "offerTtlMs",
  "shareValues",
  "linkOrigins",
  "replies",
  "texts",
  "affirm",
  "deny",
  "undo",
  "timezone",
  "fill",
  "calibration",
  "overrides",
] as const;

/**
 * Validates a decision policy. `policy` is null when there is an error,
 * except `flow/policy-uncalibrated` (`auto` without matching calibration),
 * which the runtime answers by running as `suggest` and recording the
 * downgrade.
 */
export function parseDecisionPolicy(raw: unknown): { policy: DecisionPolicy | null; diagnostics: Diagnostic[] } {
  const bag = new DiagnosticBag();
  const issue = checkJson(raw);
  if (issue) {
    bag.error("flow/policy-invalid", issue.path, `the policy must be plain JSON: ${issue.message}`);
    return { policy: null, diagnostics: bag.items };
  }
  if (!isJsonObject(raw)) {
    bag.error("flow/policy-invalid", [], "the policy must be an object");
    return { policy: null, diagnostics: bag.items };
  }
  checkPart(raw, [], bag, true);
  if (MODES.includes(raw.mode as RoutingMode)) {
    checkCalibration(raw as unknown as DecisionPolicy, [], bag);
    const overrides = Array.isArray(raw.overrides) ? raw.overrides : [];
    overrides.forEach((o, i) => {
      if (isJsonObject(o) && isJsonObject(o.set)) checkCalibration(merge(raw as unknown as DecisionPolicy, o.set as Partial<DecisionPolicy>), ["overrides", i, "set"], bag);
    });
  }
  const blocking = bag.items.some((d) => d.severity === "error" && d.code !== "flow/policy-uncalibrated");
  return { policy: blocking ? null : (structuredClone(raw) as unknown as DecisionPolicy), diagnostics: bag.items };
}

function checkPart(raw: Record<string, JsonValue>, path: PathSegment[], bag: DiagnosticBag, top: boolean): void {
  const invalid = (key: string, message: string) => bag.error("flow/policy-invalid", [...path, key], message);
  for (const key of Object.keys(raw)) {
    if (key.startsWith("x-")) continue;
    if (!(POLICY_KEYS as readonly string[]).includes(key) || (!top && key === "overrides")) invalid(key, `unknown policy field "${key}"`);
  }
  if (top || raw.mode !== undefined) {
    if (!MODES.includes(raw.mode as RoutingMode)) invalid("mode", "mode is off, suggest or auto");
  }
  if (raw.version !== undefined && (typeof raw.version !== "string" || raw.version.length === 0 || raw.version.length > 64)) invalid("version", "version is a string of at most 64 characters");
  for (const key of ["stages", "shadow"] as const) {
    const v = raw[key];
    if (v !== undefined && (!Array.isArray(v) || v.length > 8 || v.some((s) => typeof s !== "string" || !STAGE_NAME.test(s)) || new Set(v).size !== v.length)) {
      invalid(key, `${key} lists at most 8 distinct stage names`);
    }
  }
  for (const key of ["platformFallback", "exact"] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== "boolean") invalid(key, `${key} is a boolean`);
  }
  if (raw.thresholds !== undefined) {
    const t = raw.thresholds;
    if (!isJsonObject(t)) invalid("thresholds", "thresholds is an object");
    else {
      for (const key of Object.keys(t)) {
        if (!["openAt", "suggestAt", "margin"].includes(key)) bag.error("flow/policy-invalid", [...path, "thresholds", key], `unknown threshold "${key}"`);
        else if (!unit(t[key])) bag.error("flow/policy-invalid", [...path, "thresholds", key], `${key} is a number from 0 to 1`);
      }
      const openAt = unit(t.openAt) ? t.openAt : DEFAULT_THRESHOLDS.openAt;
      const suggestAt = unit(t.suggestAt) ? t.suggestAt : DEFAULT_THRESHOLDS.suggestAt;
      if (suggestAt > openAt) bag.error("flow/policy-thresholds", [...path, "thresholds"], `suggestAt (${suggestAt}) must not exceed openAt (${openAt})`);
    }
  }
  const integer = (key: string, min: number, max: number) => {
    const v = raw[key];
    if (v !== undefined && (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max)) invalid(key, `${key} is an integer from ${min} to ${max}`);
  };
  integer("maxOptions", 1, MAX_OPTIONS_CAP);
  integer("maxRoutingText", 1, 4000);
  integer("offerTtlMs", 1000, 24 * 60 * 60 * 1000);
  if (raw.shareValues !== undefined && !["none", "nonPersonal", "nonSecret"].includes(raw.shareValues as string)) invalid("shareValues", "shareValues is none, nonPersonal or nonSecret");
  if (raw.linkOrigins !== undefined) {
    const v = raw.linkOrigins;
    if (!Array.isArray(v) || v.length > 50 || v.some((o) => !isOrigin(o))) invalid("linkOrigins", 'linkOrigins lists https origins such as "https://help.example.com"');
  }
  if (raw.replies !== undefined) compilePolicyReplies(raw.replies, [...path, "replies"], bag);
  if (raw.texts !== undefined) {
    const t = raw.texts;
    if (!isJsonObject(t)) invalid("texts", "texts is an object");
    else
      for (const [key, value] of Object.entries(t)) {
        if (!(TEXT_KEYS as string[]).includes(key)) bag.error("flow/policy-invalid", [...path, "texts", key], `unknown text "${key}"`);
        else if (typeof value !== "string" || value.trim() === "" || value.length > 500) bag.error("flow/policy-invalid", [...path, "texts", key], "a text is a non-empty string of at most 500 characters");
      }
  }
  if (raw.timezone !== undefined && !validZone(raw.timezone)) invalid("timezone", "timezone is an IANA time zone name such as \"Asia/Kolkata\"");
  if (raw.fill !== undefined && !FILL_MODES.includes(raw.fill as FillMode)) invalid("fill", "fill is never, suggest, confirm or auto");
  for (const key of ["affirm", "deny", "undo"] as const) {
    const v = raw[key];
    if (v !== undefined && (!Array.isArray(v) || v.length > 20 || v.some((w) => typeof w !== "string" || w.trim() === "" || w.length > 40))) invalid(key, `${key} lists at most 20 words of at most 40 characters`);
  }
  if (raw.calibration !== undefined && !isCalibrationShape(raw.calibration)) {
    invalid("calibration", "calibration is {report, thresholds: {openAt, suggestAt, margin}, mode: \"auto\", stages?, digest}, as a passing holdout report gives it");
  }
  if (top && raw.overrides !== undefined) {
    const v = raw.overrides;
    if (!Array.isArray(v) || v.length > 20) invalid("overrides", "overrides lists at most 20 entries");
    else
      v.forEach((o, i) => {
        const at: PathSegment[] = ["overrides", i];
        if (!isJsonObject(o) || !isJsonObject(o.when) || !isJsonObject(o.set) || Object.keys(o).some((k) => k !== "when" && k !== "set")) {
          bag.error("flow/policy-invalid", at, "an override is {when: {channel?, locale?}, set: {...}}");
          return;
        }
        const when = o.when;
        const keys = Object.keys(when);
        if (keys.length === 0 || keys.some((k) => k !== "channel" && k !== "locale") || keys.some((k) => typeof when[k] !== "string" || (when[k] as string).length === 0 || (when[k] as string).length > 64)) {
          bag.error("flow/policy-invalid", [...at, "when"], "when names a channel, a locale or both");
        }
        checkPart(o.set, [...at, "set"], bag, false);
      });
  }
}

function checkCalibration(policy: DecisionPolicy, path: PathSegment[], bag: DiagnosticBag): void {
  if (policy.mode !== "auto" || isCalibrated(policy)) return;
  bag.error(
    "flow/policy-uncalibrated",
    path,
    !policy.calibration
      ? "auto needs calibration: what a passing holdout run in auto earned; until then turns run as suggest"
      : policy.calibration.digest !== calibrationDigest(policy.calibration)
        ? "the calibration's digest does not match its fields: it was changed after the evaluation gave it; until then turns run as suggest"
        : "auto needs calibration whose thresholds are exactly the ones in effect; until then turns run as suggest",
  );
}

const unit = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
const HEX64 = /^[0-9a-f]{64}$/;
const SHORT = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,63}$/;

/** Whether `c` has a calibration's shape (its digest is checked by `isCalibrated`). */
function isCalibrationShape(c: unknown): c is Calibration {
  if (!isJsonObject(c) || !Object.keys(c).every((k) => ["report", "thresholds", "mode", "stages", "digest"].includes(k))) return false;
  const t = c.thresholds;
  if (typeof c.report !== "string" || !HEX64.test(c.report) || typeof c.digest !== "string" || !HEX64.test(c.digest) || c.mode !== "auto") return false;
  if (!isJsonObject(t) || Object.keys(t).length !== 3 || !unit(t.openAt) || !unit(t.suggestAt) || !unit(t.margin)) return false;
  if (c.stages === undefined) return true;
  if (!Array.isArray(c.stages) || c.stages.length > 16) return false;
  return c.stages.every((st) => {
    if (!isJsonObject(st) || !Object.keys(st).every((k) => k === "name" || k === "adapter" || k === "models")) return false;
    if (typeof st.name !== "string" || !STAGE_NAME.test(st.name)) return false;
    const a = st.adapter;
    if (a !== undefined && !(isJsonObject(a) && Object.keys(a).length === 2 && typeof a.id === "string" && SHORT.test(a.id) && typeof a.version === "string" && SHORT.test(a.version))) return false;
    const m = st.models;
    return m === undefined || (Array.isArray(m) && m.length > 0 && m.length <= 16 && m.every((x) => typeof x === "string" && SHORT.test(x)));
  });
}

/**
 * The digest that binds a calibration's fields together: SHA-256 (hex) of
 * the canonical JSON of `report`, `thresholds`, `mode` and `stages`.
 */
export function calibrationDigest(c: Omit<Calibration, "digest">): string {
  const body = { report: c.report, thresholds: { openAt: c.thresholds.openAt, suggestAt: c.thresholds.suggestAt, margin: c.thresholds.margin }, mode: c.mode, ...(c.stages !== undefined ? { stages: c.stages } : {}) };
  return toHex(sha256(canonicalJson(body as unknown as JsonValue)));
}

/** A calibration with its digest. For the evaluation kit and tests: a host never makes one by hand. */
export function sealCalibration(c: Omit<Calibration, "digest">): Calibration {
  const stages = c.stages?.map((st) => ({ name: st.name, ...(st.adapter ? { adapter: { id: st.adapter.id, version: st.adapter.version } } : {}), ...(st.models ? { models: [...st.models] } : {}) }));
  const out = { report: c.report, thresholds: { ...c.thresholds }, mode: c.mode, ...(stages !== undefined ? { stages } : {}) };
  return { ...out, digest: calibrationDigest(out) };
}

function isOrigin(v: unknown): boolean {
  if (typeof v !== "string") return false;
  try {
    const url = new URL(v);
    return url.protocol === "https:" && url.username === "" && url.password === "" && url.pathname === "/" && url.search === "" && url.hash === "" && url.origin === v.replace(/\/$/, "");
  } catch {
    return false;
  }
}

/** The thresholds in effect: the policy's over the defaults. */
export function effectiveThresholds(policy: Pick<DecisionPolicy, "thresholds">): DecisionThresholds {
  return { ...DEFAULT_THRESHOLDS, ...(policy.thresholds ?? {}) };
}

/**
 * Whether the policy's calibration hangs together: from a run in `auto`, its
 * digest matching its fields, and naming exactly the thresholds in effect.
 * That it was earned (a passing holdout report with that digest exists) is
 * for the host to check when the policy is saved: `verifyCalibration`.
 */
export function isCalibrated(policy: DecisionPolicy): boolean {
  const c = policy.calibration;
  if (!c || !isCalibrationShape(c) || c.digest !== calibrationDigest(c)) return false;
  const t = effectiveThresholds(policy);
  return c.thresholds.openAt === t.openAt && c.thresholds.suggestAt === t.suggestAt && c.thresholds.margin === t.margin;
}

function merge(base: DecisionPolicy, set: Partial<DecisionPolicy>): DecisionPolicy {
  const out: DecisionPolicy = { ...base, ...set };
  if (set.thresholds) out.thresholds = { ...(base.thresholds ?? {}), ...set.thresholds };
  if (set.texts) out.texts = { ...(base.texts ?? {}), ...set.texts };
  if (set.replies) out.replies = { ...(base.replies ?? {}), ...set.replies };
  delete out.overrides;
  return out;
}

function localeMatches(locale: string, wanted: string): boolean {
  const a = locale.toLowerCase();
  const b = wanted.toLowerCase();
  return a === b || a.startsWith(`${b}-`);
}

/**
 * The policy for one turn: the first override whose `when` matches the
 * channel and locale is applied, defaults are filled, and `auto` without
 * matching calibration runs as `suggest` (`downgraded`). Pass a policy that
 * `parseDecisionPolicy` accepted.
 */
export function resolvePolicy(policy: DecisionPolicy, at: { channel?: string | undefined; locale: string }): ResolvedPolicy {
  const override = (policy.overrides ?? []).find(
    (o) => (o.when.channel === undefined || o.when.channel === at.channel) && (o.when.locale === undefined || localeMatches(at.locale, o.when.locale)),
  );
  const p = override ? merge(policy, override.set) : policy;
  const downgraded = p.mode === "auto" && !isCalibrated(p);
  const replies = new Map<ReplyViewKey, CompiledView>();
  if (p.replies) {
    const bag = new DiagnosticBag();
    for (const [key, view] of compilePolicyReplies(p.replies as unknown as JsonValue, ["replies"], bag)) replies.set(key, view);
  }
  return {
    mode: downgraded ? "suggest" : p.mode,
    ...(p.version !== undefined ? { version: p.version } : {}),
    ...(p.stages !== undefined ? { stages: [...p.stages] } : {}),
    shadow: [...(p.shadow ?? [])],
    platformFallback: p.platformFallback === true,
    exact: p.exact !== false,
    thresholds: effectiveThresholds(p),
    maxOptions: Math.min(p.maxOptions ?? DEFAULT_MAX_OPTIONS, MAX_OPTIONS_CAP),
    maxRoutingText: p.maxRoutingText ?? DEFAULT_MAX_ROUTING_TEXT,
    offerTtlMs: p.offerTtlMs ?? DEFAULT_OFFER_TTL_MS,
    shareValues: p.shareValues ?? "nonSecret",
    linkOrigins: (p.linkOrigins ?? []).map((o) => new URL(o).origin),
    replies,
    texts: { ...DEFAULT_TEXTS, ...(p.texts ?? {}) },
    affirm: [...(p.affirm ?? DEFAULT_AFFIRM)],
    deny: [...(p.deny ?? DEFAULT_DENY)],
    undo: [...(p.undo ?? DEFAULT_UNDO)],
    ...(p.timezone !== undefined ? { timezone: p.timezone } : {}),
    ...(p.fill !== undefined ? { fill: p.fill } : {}),
    ...(p.mode === "auto" && !downgraded && p.calibration?.stages ? { calibratedStages: sealCalibration(p.calibration).stages! } : {}),
    downgraded,
  };
}

/**
 * Whether an `auto` turn may act on a proposal on its own: the stage that
 * proposed it is one the calibration was earned with (same name and
 * adapter; and when the calibration saw models, a reported model among
 * them, while a stage that reported none must still report none), or, for a
 * port that reports no stages, the calibration names none. Always true
 * without a stage binding.
 */
export function stageCalibrated(policy: ResolvedPolicy, proposedBy: { name: string; adapter?: { id: string; version: string }; usage?: { model: string } } | null): boolean {
  const bound = policy.calibratedStages;
  if (!bound) return true;
  if (!proposedBy) return bound.length === 0;
  return bound.some(
    (st) =>
      st.name === proposedBy.name &&
      (st.adapter === undefined ? proposedBy.adapter === undefined : proposedBy.adapter !== undefined && st.adapter.id === proposedBy.adapter.id && st.adapter.version === proposedBy.adapter.version) &&
      (st.models === undefined ? proposedBy.usage === undefined : proposedBy.usage !== undefined && st.models.includes(proposedBy.usage.model)),
  );
}

/** A text with `{flow}`, `{from}` and `{to}` filled in. */
export function policyText(policy: ResolvedPolicy, key: TextKey, values: { flow?: string; from?: string; to?: string } = {}): string {
  return policy.texts[key].replace(/\{(flow|from|to)\}/g, (whole, name: "flow" | "from" | "to") => values[name] ?? whole);
}

/**
 * Compiles a policy's reply views. A policy's views read only the reply
 * (`{"payload": [...]}`) and the environment, never facts or results.
 * Problems go to `bag`; views with problems are left out.
 */
export function compilePolicyReplies(raw: unknown, path: PathSegment[], bag: DiagnosticBag): Map<ReplyViewKey, CompiledView> {
  const out = new Map<ReplyViewKey, CompiledView>();
  if (!isJsonObject(raw)) {
    bag.error("flow/policy-invalid", path, "replies is an object of reply views");
    return out;
  }
  for (const [key, view] of Object.entries(raw)) {
    if (key.startsWith("x-")) continue;
    const at = [...path, key];
    if (!isReplyViewKey(key)) {
      bag.error("flow/reply-unknown-kind", at, `reply kinds are answer, nomatch, clarify, consent, suggest and default, not "${key}"`);
      continue;
    }
    const compiled = compileReplyView(view, at, bag, false);
    if (compiled) out.set(key, compiled);
  }
  return out;
}

/**
 * Compiles one reply view: a section reference and input expressions reading
 * the reply as `payload` (and, when `allowFacts`, the run's facts). Returns
 * null with diagnostics in `bag` when it is not valid.
 */
export function compileReplyView(raw: unknown, path: PathSegment[], bag: DiagnosticBag, allowFacts: boolean): CompiledView | null {
  const before = bag.items.length;
  if (!isJsonObject(raw)) {
    bag.error("flow/invalid-shape", path, "a reply view is {section, input?}");
    return null;
  }
  for (const key of Object.keys(raw)) if (key !== "section" && key !== "input" && !key.startsWith("x-")) bag.error("flow/unknown-field", [...path, key], `unknown field "${key}"`);
  if (typeof raw.section !== "string" || !SECTION_RE.test(raw.section)) {
    bag.error("flow/invalid-section", [...path, "section"], 'section must be a section reference such as "chat-bubble@2"');
  } else if (!raw.section.includes("@")) {
    bag.warn("flow/section-unversioned", [...path, "section"], `section "${raw.section}" names no version, so it can change under a published policy; pin one, as in "${raw.section}@1"`);
  }
  const input: Array<[string, Node]> = [];
  const reads = emptyReads();
  if (raw.input !== undefined) {
    if (!isJsonObject(raw.input)) bag.error("flow/invalid-shape", [...path, "input"], "view input must be an object of expressions");
    else
      for (const [key, expr] of Object.entries(raw.input)) {
        const parsed = parseExpr(expr, [...path, "input", key], bag, { scopes: REPLY_SCOPES });
        if (parsed) {
          input.push([key, parsed.node]);
          mergeReads(reads, parsed.reads);
        }
      }
  }
  const view: CompiledView = { section: typeof raw.section === "string" ? raw.section : "", input, reads };
  checkReplyScope(view, path, bag, allowFacts);
  return bag.items.slice(before).some((d) => d.severity === "error") ? null : view;
}
