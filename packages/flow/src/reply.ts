/**
 * Text replies: what `turn` says back when the answer is words rather than a
 * run, as channel-neutral data.
 *
 * A `Reply` always carries plain `text` (for voice and SMS) and, for an offer,
 * the options to pick from. When the active flow or the tenant's policy names
 * a reply view, the reply also names a Facet section and its input, so a web
 * or native shell can present it; the section's `input` expressions read the
 * reply itself as `{"payload": [...]}`.
 *
 * Reply content proposed by a model is untrusted: it is closed (text, lists
 * and links), bounded, and its links are kept only when they are https and
 * on the tenant's `linkOrigins`.
 */

import type { EnvironmentKind } from "@aaply/action-contract";
import type { CompiledView } from "./compile.js";
import type { Expr } from "./expr.js";
import type { Extensions } from "./definition.js";
import type { DiagnosticBag } from "./diagnostics.js";
import { nodeChildren, type Node } from "./expr.js";
import { evaluate, type EvalEnv } from "./expr-eval.js";
import { checkJson, isJsonObject, jsonByteLength, type JsonObject, type JsonValue, type PathSegment } from "./json.js";

/** What a reply is for. */
export type ReplyKind = "answer" | "nomatch" | "clarify" | "consent" | "suggest";

/** The keys of a `replies` map: one view per kind, and a `default` for the rest. */
export type ReplyViewKey = ReplyKind | "default";

/** Every reply kind (frozen). */
export const REPLY_KINDS: readonly ReplyKind[] = Object.freeze(["answer", "nomatch", "clarify", "consent", "suggest"]);
/** Every key a `replies` map may use: the reply kinds and `default`. Frozen: the compiler reads it. */
export const REPLY_VIEW_KEYS: readonly ReplyViewKey[] = Object.freeze([...REPLY_KINDS, "default"]);

/** Whether `key` is a reply kind or `default`. */
export function isReplyViewKey(key: string): key is ReplyViewKey {
  return (REPLY_VIEW_KEYS as readonly string[]).includes(key);
}

/** A Facet section that presents a reply. `input` reads the reply as `{"payload": [...]}`. */
export interface ReplyViewDef extends Extensions {
  section: string;
  input?: Record<string, Expr>;
}

/** Reply views by kind, in a flow (`replies`) or a decision policy. */
export type ReplyViews = Partial<Record<ReplyViewKey, ReplyViewDef>>;

/** One block of reply content. */
export type ReplyBlock = { type: "text"; text: string } | { type: "list"; items: string[] } | { type: "link"; title: string; url: string };

/** Structured answer content: closed and bounded. */
export interface ReplyContent {
  blocks: ReplyBlock[];
  sources?: Array<{ title: string; url?: string }>;
}

/** An option of an offer, as a person sees it. */
export interface ReplyOption {
  /** Pass to `choose` as `option`. Positional: "1" is the first option. */
  id: string;
  title: string;
  description?: string;
  /** Picking it brings back a run the person set aside, rather than starting a new one. */
  resumes: boolean;
}

/** What `turn` says back, as data any channel can render. */
export interface Reply {
  kind: ReplyKind;
  /** Always filled, so a voice or SMS channel can say it as it is. */
  text: string;
  /** A `flow/...` code saying why, when the reply stands in for something that did not happen. */
  reason?: string;
  content?: ReplyContent;
  options?: ReplyOption[];
  /** The Facet section to present it with, when the flow or the policy names one. */
  view?: { section: string; input: JsonObject; instanceKey: string };
}

// ---------------------------------------------------------------------------
// Limits and parsing
// ---------------------------------------------------------------------------

/** Most blocks one reply's content holds. */
export const MAX_REPLY_BLOCKS = 20;
/** Largest reply content, in bytes of JSON. */
export const MAX_REPLY_BYTES = 8 * 1024;
const MAX_BLOCK_TEXT = 2000;
const MAX_LIST_ITEMS = 20;
const MAX_ITEM_TEXT = 500;
const MAX_TITLE = 200;
const MAX_URL = 2000;
const MAX_SOURCES = 10;

const text = (v: unknown, max: number): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= max;

function httpsUrl(v: unknown): v is string {
  if (typeof v !== "string" || v.length > MAX_URL) return false;
  try {
    const url = new URL(v);
    return url.protocol === "https:" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

/**
 * Validates reply content a model proposed. Returns null when it is not
 * well formed: an unknown block type, more than 20 blocks, more than 8 KiB,
 * or a link that is not an https URL.
 */
export function parseReplyContent(raw: unknown): ReplyContent | null {
  if (!isJsonObject(raw) || checkJson(raw) !== null || jsonByteLength(raw) > MAX_REPLY_BYTES) return null;
  for (const key of Object.keys(raw)) if (key !== "blocks" && key !== "sources") return null;
  if (!Array.isArray(raw.blocks) || raw.blocks.length === 0 || raw.blocks.length > MAX_REPLY_BLOCKS) return null;
  const blocks: ReplyBlock[] = [];
  for (const b of raw.blocks) {
    if (!isJsonObject(b)) return null;
    if (b.type === "text" && text(b.text, MAX_BLOCK_TEXT) && Object.keys(b).length === 2) blocks.push({ type: "text", text: b.text });
    else if (b.type === "list" && Array.isArray(b.items) && b.items.length > 0 && b.items.length <= MAX_LIST_ITEMS && b.items.every((i) => text(i, MAX_ITEM_TEXT)) && Object.keys(b).length === 2) {
      blocks.push({ type: "list", items: [...(b.items as string[])] });
    } else if (b.type === "link" && text(b.title, MAX_TITLE) && httpsUrl(b.url) && Object.keys(b).length === 3) blocks.push({ type: "link", title: b.title, url: b.url });
    else return null;
  }
  const out: ReplyContent = { blocks };
  if (raw.sources !== undefined) {
    if (!Array.isArray(raw.sources) || raw.sources.length > MAX_SOURCES) return null;
    const sources: NonNullable<ReplyContent["sources"]> = [];
    for (const s of raw.sources) {
      if (!isJsonObject(s) || !text(s.title, MAX_TITLE) || Object.keys(s).some((k) => k !== "title" && k !== "url")) return null;
      if (s.url !== undefined && !httpsUrl(s.url)) return null;
      sources.push({ title: s.title, ...(typeof s.url === "string" ? { url: s.url } : {}) });
    }
    out.sources = sources;
  }
  return out;
}

/** Whether `url` is https and its origin is one of `origins`. */
export function linkAllowed(url: string, origins: readonly string[]): boolean {
  if (!httpsUrl(url)) return false;
  return origins.includes(new URL(url).origin);
}

/**
 * Keeps only links whose origin is on `origins`: link blocks elsewhere are
 * dropped, and so are source URLs (the source's title stays). A kept URL is
 * stored in its normalised form (`new URL(url).href`), the form that was
 * checked, since another parser may read the raw text as another host.
 * Returns null when nothing is left to show.
 */
export function filterReplyLinks(content: ReplyContent, origins: readonly string[]): ReplyContent | null {
  const blocks = content.blocks.flatMap((b): ReplyContent["blocks"] => (b.type !== "link" ? [b] : linkAllowed(b.url, origins) ? [{ ...b, url: new URL(b.url).href }] : []));
  if (blocks.length === 0) return null;
  const out: ReplyContent = { blocks };
  if (content.sources) out.sources = content.sources.map((s) => (s.url === undefined ? s : linkAllowed(s.url, origins) ? { ...s, url: new URL(s.url).href } : { title: s.title }));
  return out;
}

// ---------------------------------------------------------------------------
// Reply views
// ---------------------------------------------------------------------------

/** Expression scopes a reply input may use: the reply itself. */
export const REPLY_SCOPES: ReadonlySet<"payload" | "value" | "resource"> = new Set(["payload", "value", "resource"]);

/**
 * Reports `flow/reply-scope` for references a reply input may not make:
 * action results (`result`, `failed`), `value` and `resource` always, and
 * facts (`fact`, `known`) unless `allowFacts` (a flow's own replies may read
 * its non-secret facts; a policy's may not). `value` and `resource` are
 * parsed (so they can be reported here by name) and refused.
 */
export function checkReplyScope(view: CompiledView, path: PathSegment[], bag: DiagnosticBag, allowFacts: boolean): void {
  for (const [key, node] of view.input) {
    const bad = new Set<string>();
    walk(node, (n) => {
      if (n.k === "result" || n.k === "failed" || n.k === "value" || n.k === "resource") bad.add(n.k);
      if (!allowFacts && (n.k === "fact" || n.k === "known")) bad.add(n.k);
    });
    for (const what of bad) bag.error("flow/reply-scope", [...path, "input", key], `a reply input cannot read "${what}"; it reads the reply as {"payload": [...]}${allowFacts ? " and the run's facts" : ""}`);
  }
}

function walk(node: Node, visit: (n: Node) => void): void {
  visit(node);
  for (const child of nodeChildren(node)) walk(child, visit);
}

/** The reply as its view reads it: everything but the view itself. */
export function replyPayload(reply: Reply): JsonObject {
  const { view: _view, ...rest } = reply;
  return JSON.parse(JSON.stringify(rest)) as JsonObject;
}

/**
 * Evaluates a reply view's input against the reply (as `payload`) and the
 * environment `env` (facts, when the view is the run's own). Values that are
 * not known evaluate to null, as in step views.
 */
export function evaluateReplyInput(view: CompiledView, reply: Reply, env: EvalEnv): JsonObject {
  const payload = replyPayload(reply);
  const scoped: EvalEnv = { ...env, payload };
  const out: JsonObject = {};
  for (const [key, node] of view.input) {
    const r = evaluate(node, scoped);
    Object.defineProperty(out, key, { value: r.known ? (r.value as JsonValue) : null, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

/** An environment with no facts or results, for a policy's reply views. */
export function bareEnv(env: { locale: string; timezone: string; environment: EnvironmentKind }, now: number): EvalEnv {
  return {
    fact: () => ({ known: false }),
    isKnown: () => false,
    result: () => ({ known: false }),
    isFailed: () => false,
    env: (name) => env[name],
    now,
  };
}
