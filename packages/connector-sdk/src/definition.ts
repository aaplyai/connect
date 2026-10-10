/**
 * Connector definitions: what a connector is, what each of its operations
 * reads and writes, where it may connect, and how a write is undone.
 *
 * A connector adapts one outside service (an API, a database gateway, a SaaS
 * app such as mail, file storage or notes) into operations that flows run as
 * actions, addressed as `"<connectorId>.<operation>"`, e.g. `"example-notes.create"`.
 *
 *   export const notes = defineConnector({
 *     id: "example-notes", version: "1.0.0", title: "Example Notes",
 *     auth: { kind: "oauth2", scopes: ["notes.read"] },
 *     egress: ["GET api.example.com/v1/notes/*"],
 *     operations: {
 *       get: {
 *         title: "Get a note", effect: "read",
 *         input: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
 *         output: { type: "object" },
 *         async handler(input: { id: string }, ctx) {
 *           const res = await ctx.http({ url: `https://api.example.com/v1/notes/${encodeURIComponent(input.id)}` });
 *           return res.ensureOk().json();
 *         },
 *       },
 *     },
 *   });
 *
 * Everything except the handlers is plain JSON and forms the connector's
 * manifest ({@link manifestOf}); its digest ({@link manifestDigest}) is what
 * a signed or pinned connector will be identified by.
 */

import { DiagnosticBag, DiagnosticsError, canonicalJson, checkJson, checkSchema, cloneJson, isJsonObject, isOperationCompletion, MAX_COMPLETION_WINDOW_MS, sha256, toHex, type Diagnostic, type JsonObject, type JsonSchema, type JsonValue, type OperationCompletion, type OperationContract, type PathSegment, type Risk } from "@aaply/action-contract";
import { fixedPattern } from "@aaply/action-contract/internal";
import type { ConnectorBlobs } from "./blobs.js";
import { SAFE_METHODS, hostCovers, parseEgressRule, parseHostPattern, ruleCovers, type EgressRule, type HostPattern } from "./egress.js";
import type { ConnectorHttp } from "./http.js";
import type { ConnectorLog } from "./log.js";
import type { WebhookHooks } from "./webhooks.js";

/**
 * How a connection authenticates. `hosts` (oauth2 and apiKey) are the only
 * hosts the connection's credential is sent to: exact names or `*.` wildcards,
 * each covered by the connector's egress. Left out, it is the one host the
 * egress names; a connector whose egress names several hosts, or a wildcard,
 * must list them, so a credential never follows a handler to a file or CDN
 * host it also calls.
 */
export type AuthSpec =
  /**
   * Delegated access. `scopes` are every scope the connector may ask for. An
   * operation that declares its own `scopes` needs only those, so adding a
   * scope for a new operation asks only its users to consent again; one that
   * declares none needs all of them.
   */
  | { readonly kind: "oauth2"; readonly scopes: readonly string[]; readonly hosts?: readonly string[] }
  | { readonly kind: "apiKey"; readonly hosts?: readonly string[] }
  | { readonly kind: "none" };

export type OperationEffect = "read" | "write";

/** The least review a flow must put in front of the operation (the flow's `risk`). The contract's `Risk`. */
export type RiskFloor = Risk;

/** What a handler gets besides its input. */
export interface OperationContext {
  /** The only network access: egress-checked, credentialed, bounded fetch. */
  readonly http: ConnectorHttp;
  /** Stable for every attempt of one effect. Send it to services that de-duplicate on a key. */
  readonly idempotencyKey: string;
  /** Aborted when the call times out or the engine gives up on it. */
  readonly signal: AbortSignal;
  /** Epoch milliseconds (on the host's clock) by which the call must be finished. */
  readonly deadline: number;
  /** The real connection the flow's connection role was bound to. */
  readonly connection: { readonly id: string; readonly role: string | null };
  /** Redacting logger; see {@link ConnectorLog}. */
  readonly log: ConnectorLog;
  /**
   * The W3C `traceparent` of the request that set this work in motion, when
   * the engine sent a well-formed one: for correlating the service's logs.
   * `ctx.http` sends it as the `traceparent` header only for a connector
   * with `propagateTrace: true`.
   */
  readonly traceparent?: string;
  /**
   * Hands the result to later: the service accepted the work and will report
   * it (a webhook, a job). `ref` is the service's own reference for it (1-256
   * printable ASCII characters, no spaces). The call answers `pending`, and
   * the host completes the action when the result arrives (see the port's
   * `deferred` option). Throws, so nothing after it runs.
   */
  defer(ref: string): never;  /**
   * The host's file store (ADR-0008): `put` stores content and answers a
   * `BlobRef` to name in the output; `get` reads one the call was given or
   * stored. Without a store on the port, both throw `connect/blob-no-store`.
   */
  readonly blobs: ConnectorBlobs;
}

export interface OperationDefinition {
  title: string;
  description?: string;
  effect: OperationEffect;
  /** Schema of the input; must be `type: "object"`. Checked before the handler runs. */
  input: JsonSchema;
  /** Schema of the output. Checked after the handler returns. */
  output: JsonSchema;
  /** A write the service de-duplicates (on `ctx.idempotencyKey` or by its nature, like DELETE), so it may be sent again. */
  idempotent?: boolean;
  /** The write operation that undoes this one. */
  compensate?: string;
  /** Cannot be undone (a sent email, a payment). */
  irreversible?: boolean;
  /** Writes only. */
  riskFloor?: RiskFloor;
  /** Narrows the connector's egress for this operation; every rule must be covered by the connector's. */
  egress?: readonly string[];
  /**
   * OAuth connectors only: the scopes this operation needs, each one of the
   * connector's `auth.scopes`. A connection is checked for these alone.
   * Left out, the operation needs every scope the connector lists.
   */
  scopes?: readonly string[];
  /**
   * How long the service may take to report a result the handler deferred
   * with `ctx.defer`, when that is longer than a request takes: `{ windowMs }`,
   * at most 30 days. The engine waits that long for the completion instead of
   * the flow call's `timeoutMs`, and the host's `deferred` sink is told it.
   * Part of the operation contract, so a flow pinned before it was declared
   * must be pinned again.
   */
  completion?: OperationCompletion;
  /**
   * Does the work. Return the output (plain JSON) when the operation was
   * applied; throw a `ConnectorError` otherwise. Annotate `input` with the
   * shape the input schema guarantees (a type alias or inline type).
   */
  handler(input: JsonObject, ctx: OperationContext): Promise<JsonValue> | JsonValue;
}

export interface ConnectorDefinition {
  /** Lowercase kebab case, e.g. "example-notes". The first part of every action id. */
  id: string;
  /** Semantic version, e.g. "1.2.0". */
  version: string;
  title: string;
  description?: string;
  auth: AuthSpec;
  /** Every place the connector may call: "METHOD host/path" rules. See `egress.ts`. */
  egress: readonly string[];
  operations: Record<string, OperationDefinition>;
  /** Optional: verifies and parses the webhooks the service pushes (see `handleWebhook`). */
  webhooks?: WebhookHooks;
  /**
   * Send the engine's `traceparent` (the request that set the work in
   * motion) to the service as the `traceparent` header on every `ctx.http`
   * request, unless the handler sets that header itself. Off by default: it
   * tells the service a trace id. Carried in the manifest only when true.
   */
  propagateTrace?: boolean;
}

/** A validated operation with its defaults filled in. */
export interface Operation {
  readonly title: string;
  readonly description?: string;
  readonly effect: OperationEffect;
  readonly input: JsonSchema;
  readonly output: JsonSchema;
  readonly idempotent: boolean;
  readonly compensate?: string;
  readonly irreversible: boolean;
  readonly riskFloor: RiskFloor;
  /** Effective egress: the operation's own rules, or else the connector's. */
  readonly egress: readonly string[];
  /** The OAuth scopes the operation declared, when it declared any (see {@link scopesNeeded}). */
  readonly scopes?: readonly string[];
  /** The completion window it declared, when it declared one. */
  readonly completion?: Readonly<OperationCompletion>;
  readonly handler: OperationDefinition["handler"];
}

/** A validated, frozen connector, as returned by {@link defineConnector}. */
export interface Connector {
  readonly id: string;
  readonly version: string;
  readonly title: string;
  readonly description?: string;
  readonly auth: AuthSpec;
  readonly egress: readonly string[];
  readonly operations: Readonly<Record<string, Operation>>;
  readonly webhooks?: WebhookHooks;
  /** Present when the connector sends the engine's `traceparent` to its service. */
  readonly propagateTrace?: true;
}

export const MANIFEST_VERSION = 1 as const;

export interface OperationManifest {
  title: string;
  description?: string;
  effect: OperationEffect;
  input: JsonSchema;
  output: JsonSchema;
  idempotent: boolean;
  compensate?: string;
  irreversible: boolean;
  riskFloor: RiskFloor;
  egress: string[];
  scopes?: string[];
  completion?: OperationCompletion;
}

/** Everything about a connector except its code. Plain JSON. */
export interface ConnectorManifest {
  manifestVersion: typeof MANIFEST_VERSION;
  id: string;
  version: string;
  title: string;
  description?: string;
  auth: { kind: "oauth2"; scopes: string[]; hosts?: string[] } | { kind: "apiKey"; hosts?: string[] } | { kind: "none" };
  egress: string[];
  operations: Record<string, OperationManifest>;
  /** Present when the connector accepts webhooks. */
  webhooks?: true;
  /** Present when the connector sends the engine's `traceparent` to its service. */
  propagateTrace?: true;
}

export const CONNECTOR_ID_RE = fixedPattern(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
/** camelCase segments, up to four, so `<connectorId>.<operation>` is a valid flow action id. */
export const OPERATION_NAME_RE = fixedPattern(/^[a-z][a-zA-Z0-9_]{0,63}(?:\.[a-z][a-zA-Z0-9_]{0,63}){0,3}$/);
export const SEMVER_RE = fixedPattern(
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/);
const SCOPE_RE = /^[\x21-\x7e]{1,256}$/;

export const CONNECTOR_LIMITS = deepFreeze({
  maxIdLength: 64,
  maxVersionLength: 64,
  maxTitleLength: 200,
  maxDescriptionLength: 2000,
  maxScopes: 100,
  maxCredentialHosts: 20,
  maxEgressRules: 100,
  maxOperations: 200,
} as const);

const RISK_FLOORS: readonly RiskFloor[] = ["none", "confirm", "approval"];
const RISK_RANK: Record<RiskFloor, number> = { none: 0, confirm: 1, approval: 2 };
const CONNECTOR_KEYS = ["id", "version", "title", "description", "auth", "egress", "operations", "webhooks", "propagateTrace"];
const OPERATION_KEYS = ["title", "description", "effect", "input", "output", "idempotent", "compensate", "irreversible", "riskFloor", "egress", "scopes", "completion"];

/** Whether `risk` is at least `floor`. */
export function riskAtLeast(risk: RiskFloor, floor: RiskFloor): boolean {
  return RISK_RANK[risk] >= RISK_RANK[floor];
}

type Mode = "definition" | "manifest";

function checkKeys(obj: Record<string, unknown>, allowed: readonly string[], path: PathSegment[], bag: DiagnosticBag): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) bag.error("connector/unknown-field", [...path, key], `unknown field "${key}"`);
  }
}

function checkText(obj: Record<string, unknown>, key: string, path: PathSegment[], bag: DiagnosticBag, required: boolean, max: number): void {
  const v = obj[key];
  if (v === undefined && !required) return;
  if (typeof v !== "string" || (required && v.trim().length === 0) || v.length > max) {
    bag.error("connector/invalid-field", [...path, key], `${key} must be ${required ? "a non-empty" : "a"} string of at most ${max} characters`);
  }
}

function checkSchemaAs(schema: unknown, path: PathSegment[], bag: DiagnosticBag): boolean {
  const inner = new DiagnosticBag();
  checkSchema(schema, path, inner);
  for (const d of inner.items) bag.items.push({ ...d, code: "connector/invalid-schema", message: `${d.message} (${d.code})` });
  return !inner.hasErrors;
}

function parseRules(raw: unknown, path: PathSegment[], bag: DiagnosticBag): EgressRule[] | null {
  if (!Array.isArray(raw)) {
    bag.error("connector/invalid-egress", path, "egress must be a list of rules");
    return null;
  }
  if (raw.length > CONNECTOR_LIMITS.maxEgressRules) bag.error("connector/too-large", path, `at most ${CONNECTOR_LIMITS.maxEgressRules} egress rules`);
  const rules: EgressRule[] = [];
  const seen = new Set<string>();
  raw.forEach((source, i) => {
    const parsed = parseEgressRule(source);
    if ("issue" in parsed) bag.error(parsed.issue.code, [...path, i], parsed.issue.message);
    else {
      if (seen.has(parsed.rule.source)) bag.warn("connector/egress-duplicate", [...path, i], "this rule is listed twice");
      seen.add(parsed.rule.source);
      rules.push(parsed.rule);
    }
  });
  return rules;
}

function checkAuth(raw: unknown, egress: readonly EgressRule[], bag: DiagnosticBag): void {
  const path: PathSegment[] = ["auth"];
  if (!isJsonObject(raw as JsonValue)) {
    bag.error("connector/invalid-auth", path, 'auth must be {kind: "oauth2", scopes, hosts?}, {kind: "apiKey", hosts?} or {kind: "none"}');
    return;
  }
  const auth = raw as Record<string, unknown>;
  if (auth.kind === "oauth2") {
    checkKeys(auth, ["kind", "scopes", "hosts"], path, bag);
    checkCredentialHosts(auth.hosts, egress, bag);
    const scopes = auth.scopes;
    if (!Array.isArray(scopes) || scopes.length > CONNECTOR_LIMITS.maxScopes) {
      bag.error("connector/invalid-auth", [...path, "scopes"], `scopes must be a list of at most ${CONNECTOR_LIMITS.maxScopes} scope names`);
      return;
    }
    const seen = new Set<string>();
    scopes.forEach((scope, i) => {
      if (typeof scope !== "string" || !SCOPE_RE.test(scope)) bag.error("connector/invalid-auth", [...path, "scopes", i], "a scope is a non-empty name without spaces");
      else if (seen.has(scope)) bag.error("connector/invalid-auth", [...path, "scopes", i], `scope "${scope}" is listed twice`);
      else seen.add(scope);
    });
  } else if (auth.kind === "apiKey") {
    checkKeys(auth, ["kind", "hosts"], path, bag);
    checkCredentialHosts(auth.hosts, egress, bag);
  } else if (auth.kind === "none") {
    checkKeys(auth, ["kind"], path, bag);
  } else {
    bag.error("connector/invalid-auth", [...path, "kind"], "auth kind is oauth2, apiKey or none");
  }
}

/** An operation's `scopes`: an OAuth connector's, each listed once. */
function checkOperationScopes(raw: unknown, auth: unknown, path: PathSegment[], bag: DiagnosticBag): void {
  const declared = isJsonObject(auth as JsonValue) && (auth as Record<string, unknown>).kind === "oauth2" ? (auth as Record<string, unknown>).scopes : undefined;
  if (!Array.isArray(declared)) {
    bag.error("connector/invalid-field", path, "scopes apply to operations of an oauth2 connector");
    return;
  }
  if (!Array.isArray(raw) || raw.length > CONNECTOR_LIMITS.maxScopes) {
    bag.error("connector/invalid-field", path, `scopes must be a list of at most ${CONNECTOR_LIMITS.maxScopes} of the connector's scopes`);
    return;
  }
  const seen = new Set<string>();
  raw.forEach((scope, i) => {
    if (typeof scope !== "string" || !SCOPE_RE.test(scope)) bag.error("connector/invalid-field", [...path, i], "a scope is a non-empty name without spaces");
    else if (seen.has(scope)) bag.error("connector/invalid-field", [...path, i], `scope "${scope}" is listed twice`);
    else {
      seen.add(scope);
      if (!declared.includes(scope)) bag.error("connector/scope-not-declared", [...path, i], `"${scope}" is not one of the connector's auth.scopes`);
    }
  });
}

/**
 * The OAuth scopes a connection must have granted for `operation`: its own
 * `scopes`, or else every scope the connector lists. Empty for a connector
 * that is not oauth2.
 */
export function scopesNeeded(connector: Connector, operation: Operation): readonly string[] {
  if (connector.auth.kind !== "oauth2") return [];
  return operation.scopes ?? connector.auth.scopes;
}

/** The distinct hosts of `rules`, as written. */
function egressHosts(rules: readonly EgressRule[]): HostPattern[] {
  const out = new Map<string, HostPattern>();
  for (const rule of rules) out.set(`${rule.wildcard ? "*." : ""}${rule.host}`, { host: rule.host, wildcard: rule.wildcard });
  return [...out.values()];
}

/** `auth.hosts`: well formed, each covered by the egress; required when the egress names several hosts or a wildcard. */
function checkCredentialHosts(raw: unknown, egress: readonly EgressRule[], bag: DiagnosticBag): void {
  const path: PathSegment[] = ["auth", "hosts"];
  if (raw === undefined) {
    const hosts = egressHosts(egress);
    if (hosts.length > 1 || hosts.some((h) => h.wildcard)) {
      bag.error("connector/auth-hosts-required", ["auth"], "the egress names several hosts (or a wildcard): list in auth.hosts the ones the connection's credential is sent to");
    }
    return;
  }
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > CONNECTOR_LIMITS.maxCredentialHosts) {
    bag.error("connector/invalid-auth", path, `hosts must be a list of 1 to ${CONNECTOR_LIMITS.maxCredentialHosts} host names`);
    return;
  }
  const seen = new Set<string>();
  raw.forEach((source, i) => {
    const parsed = parseHostPattern(source);
    if ("issue" in parsed) bag.error("connector/invalid-auth", [...path, i], parsed.issue.message);
    else if (seen.has(source as string)) bag.error("connector/invalid-auth", [...path, i], `host "${String(source)}" is listed twice`);
    else {
      seen.add(source as string);
      if (!egress.some((rule) => hostCovers(rule, parsed.pattern))) bag.error("connector/auth-host-not-in-egress", [...path, i], `"${String(source)}" is not a host the connector's egress allows`);
    }
  });
}

/** The hosts a connector's credential is sent to: `auth.hosts`, or else the one host its egress names. */
function credentialHostsOf(auth: AuthSpec, egress: readonly EgressRule[]): readonly HostPattern[] {
  if (auth.kind === "none") return Object.freeze([]);
  const declared = auth.hosts;
  const hosts = declared !== undefined ? declared.map((h) => (parseHostPattern(h) as { pattern: HostPattern }).pattern) : egressHosts(egress);
  return Object.freeze(hosts.map((h) => Object.freeze({ host: h.host, wildcard: h.wildcard })));
}

function checkInto(raw: unknown, bag: DiagnosticBag, mode: Mode): void {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    bag.error("connector/invalid-shape", [], "a connector definition must be an object");
    return;
  }
  const def = raw as Record<string, unknown>;
  checkKeys(def, mode === "manifest" ? ["manifestVersion", ...CONNECTOR_KEYS] : CONNECTOR_KEYS, [], bag);
  if (mode === "manifest" && def.manifestVersion !== MANIFEST_VERSION) {
    bag.error("connector/invalid-field", ["manifestVersion"], `manifestVersion must be ${MANIFEST_VERSION}`);
  }
  if (typeof def.id !== "string" || def.id.length > CONNECTOR_LIMITS.maxIdLength || !CONNECTOR_ID_RE.test(def.id)) {
    bag.error("connector/invalid-id", ["id"], 'id is lowercase kebab case of at most 64 characters, e.g. "example-notes"');
  }
  if (typeof def.version !== "string" || def.version.length > CONNECTOR_LIMITS.maxVersionLength || !SEMVER_RE.test(def.version)) {
    bag.error("connector/invalid-version", ["version"], 'version is a semantic version such as "1.0.0"');
  }
  checkText(def, "title", [], bag, true, CONNECTOR_LIMITS.maxTitleLength);
  checkText(def, "description", [], bag, false, CONNECTOR_LIMITS.maxDescriptionLength);
  if (def.webhooks !== undefined) {
    const hooks = def.webhooks as Record<string, unknown> | null;
    const valid =
      mode === "manifest"
        ? hooks === (true as unknown)
        : typeof hooks === "object" && hooks !== null && typeof hooks.verify === "function" && typeof hooks.parse === "function";
    if (!valid) bag.error("connector/invalid-field", ["webhooks"], mode === "manifest" ? "webhooks is true when the connector accepts webhooks" : "webhooks must have verify and parse functions");
  }
  if (def.propagateTrace !== undefined && (mode === "manifest" ? def.propagateTrace !== true : typeof def.propagateTrace !== "boolean")) {
    bag.error(
      "connector/invalid-field",
      ["propagateTrace"],
      mode === "manifest" ? "propagateTrace is true when the connector sends the traceparent" : "propagateTrace is true or false",
      mode === "manifest" ? "Set `propagateTrace` to `true`, or remove it." : "Set `propagateTrace` to `true` or `false`, or remove it.",
    );
  }
  const connectorRules = parseRules(def.egress, ["egress"], bag) ?? [];
  checkAuth(def.auth, connectorRules, bag);

  const rawOps = def.operations;
  if (typeof rawOps !== "object" || rawOps === null || Array.isArray(rawOps)) {
    bag.error("connector/invalid-shape", ["operations"], "operations must be an object of named operations");
    return;
  }
  const names = Object.keys(rawOps);
  if (names.length === 0) bag.error("connector/no-operations", ["operations"], "a connector needs at least one operation");
  if (names.length > CONNECTOR_LIMITS.maxOperations) bag.error("connector/too-large", ["operations"], `at most ${CONNECTOR_LIMITS.maxOperations} operations`);
  const ops = rawOps as Record<string, unknown>;
  const opOf = (name: string): Record<string, unknown> | undefined => {
    const op = Object.prototype.hasOwnProperty.call(ops, name) ? ops[name] : undefined;
    return typeof op === "object" && op !== null && !Array.isArray(op) ? (op as Record<string, unknown>) : undefined;
  };

  for (const name of names) {
    const path: PathSegment[] = ["operations", name];
    if (!OPERATION_NAME_RE.test(name)) {
      bag.error("connector/invalid-operation-name", path, 'operation names are camelCase identifiers, optionally dotted, e.g. "create" or "files.upload"');
    }
    const op = opOf(name);
    if (!op) {
      bag.error("connector/invalid-shape", path, "an operation must be an object");
      continue;
    }
    checkKeys(op, mode === "definition" ? [...OPERATION_KEYS, "handler"] : OPERATION_KEYS, path, bag);
    checkText(op, "title", path, bag, true, CONNECTOR_LIMITS.maxTitleLength);
    checkText(op, "description", path, bag, false, CONNECTOR_LIMITS.maxDescriptionLength);
    const effect = op.effect;
    if (effect !== "read" && effect !== "write") bag.error("connector/invalid-effect", [...path, "effect"], "effect is read or write");

    for (const key of ["input", "output"] as const) {
      if (op[key] === undefined) {
        bag.error("connector/missing-schema", [...path, key], `an operation must declare its ${key} schema`);
        continue;
      }
      const valid = checkSchemaAs(op[key], [...path, key], bag);
      if (valid && key === "input" && (op.input as JsonSchema).type !== "object") {
        bag.error("connector/input-not-object", [...path, "input", "type"], 'the input schema must be type "object"');
      }
    }
    for (const flag of ["idempotent", "irreversible"] as const) {
      if (op[flag] !== undefined && typeof op[flag] !== "boolean") bag.error("connector/invalid-field", [...path, flag], `${flag} must be a boolean`);
    }
    if (op.riskFloor !== undefined && !RISK_FLOORS.includes(op.riskFloor as RiskFloor)) {
      bag.error("connector/invalid-field", [...path, "riskFloor"], "riskFloor is none, confirm or approval");
    }
    if (op.completion !== undefined && !isOperationCompletion(op.completion)) {
      bag.error(
        "connector/invalid-field",
        [...path, "completion"],
        `completion is { windowMs }: a positive whole number of milliseconds up to ${MAX_COMPLETION_WINDOW_MS} (30 days)`,
        `Set \`completion\` to \`{ windowMs }\` with a whole number of milliseconds from 1 to ${MAX_COMPLETION_WINDOW_MS}, or remove it.`,
      );
    }
    if (mode === "definition" && typeof op.handler !== "function") {
      bag.error("connector/missing-handler", [...path, "handler"], "an operation needs a handler function");
    }

    // Undo semantics.
    if (op.compensate !== undefined) {
      const target = typeof op.compensate === "string" ? opOf(op.compensate) : undefined;
      if (typeof op.compensate !== "string" || !target) {
        bag.error("connector/compensate-unknown", [...path, "compensate"], "compensate must name another operation of this connector");
      } else if (op.compensate === name) {
        bag.error("connector/compensate-self", [...path, "compensate"], "an operation cannot undo itself");
      } else if (target.effect !== "write") {
        bag.error("connector/compensate-not-write", [...path, "compensate"], `"${op.compensate}" is not a write, so it cannot undo anything`);
      } else {
        if (target.idempotent !== true) {
          bag.warn("connector/compensate-not-idempotent", [...path, "compensate"], `"${op.compensate}" should be idempotent: the engine may send an undo more than once`);
        }
        if (target.riskFloor !== undefined && target.riskFloor !== "none") {
          bag.warn("connector/compensate-reviewed", [...path, "compensate"], `"${op.compensate}" has risk floor "${String(target.riskFloor)}", but nobody reviews an undo: flows cannot use it as one`);
        }
      }
    }
    if (effect === "read") {
      if (op.compensate !== undefined) bag.error("connector/read-with-write-option", [...path, "compensate"], "compensate only applies to writes");
      if (op.irreversible === true) bag.error("connector/read-with-write-option", [...path, "irreversible"], "irreversible only applies to writes");
      if (op.riskFloor !== undefined && op.riskFloor !== "none") bag.error("connector/read-with-write-option", [...path, "riskFloor"], "reads have no risk floor");
    }
    if (effect === "write") {
      if (op.idempotent !== true && op.compensate === undefined && op.irreversible !== true) {
        bag.error("connector/write-needs-undo", path, "a write must declare idempotent, compensate (how to undo it) or irreversible");
      }
      if (op.compensate !== undefined && op.irreversible === true) {
        bag.error("connector/write-undo-conflict", path, "a write cannot be both compensable and irreversible");
      }
    }

    // Egress: the operation's own rules must stay inside the connector's.
    let rules = connectorRules;
    if (op.egress !== undefined) {
      const own = parseRules(op.egress, [...path, "egress"], bag);
      if (own) {
        own.forEach((rule) => {
          if (!connectorRules.some((outer) => ruleCovers(outer, rule))) {
            const index = (op.egress as unknown[]).indexOf(rule.source);
            bag.error("connector/egress-not-declared", [...path, "egress", index], `"${rule.source}" is not covered by the connector's egress`);
          }
        });
        rules = own;
      }
    }
    if (op.scopes !== undefined) checkOperationScopes(op.scopes, def.auth, [...path, "scopes"], bag);
    if (effect === "write" && rules.every((r) => SAFE_METHODS.has(r.method))) {
      bag.error("connector/write-without-unsafe-egress", path, "a write must be allowed a POST, PUT, PATCH or DELETE; GET and HEAD are treated as reads");
    }
  }
}

/** Checks a connector definition. Returns every problem found; codes are stable and start with `connector/`. */
export function validateConnector(definition: unknown): Diagnostic[] {
  const bag = new DiagnosticBag();
  checkInto(definition, bag, "definition");
  return bag.items;
}

/** Checks a manifest (a connector without its code), e.g. one submitted for review or signing. */
export function validateManifest(manifest: unknown): Diagnostic[] {
  const bag = new DiagnosticBag();
  const issue = checkJson(manifest);
  if (issue) {
    bag.error("connector/invalid-shape", issue.path, `a manifest must be plain JSON: ${issue.message}`);
    return bag.items;
  }
  checkInto(manifest, bag, "manifest");
  return bag.items;
}

// ---------------------------------------------------------------------------
// Defined connectors
// ---------------------------------------------------------------------------

/** Internal: a connector with its rules parsed, keyed by the frozen connector. */
export interface CompiledOperation {
  readonly name: string;
  readonly operation: Operation;
  readonly rules: readonly EgressRule[];
  /** The connector's credential hosts (`auth.hosts`, resolved); empty for `auth.kind: "none"`. */
  readonly credentialHosts: readonly HostPattern[];
}

export interface CompiledConnector {
  readonly connector: Connector;
  readonly operations: ReadonlyMap<string, CompiledOperation>;
}

const compiled = new WeakMap<Connector, CompiledConnector>();

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

function frozenSchema(schema: JsonSchema): JsonSchema {
  return deepFreeze(cloneJson(schema as unknown as JsonValue)) as unknown as JsonSchema;
}

function parsedRules(sources: readonly string[]): EgressRule[] {
  return sources.map((source) => {
    const parsed = parseEgressRule(source);
    if ("issue" in parsed) throw new Error(`unreachable: invalid egress rule ${source}`);
    return parsed.rule;
  });
}

/**
 * Validates a definition and returns it as a frozen connector with defaults
 * filled in. Throws `DiagnosticsError` (codes `connector/...`) when invalid.
 */
export function defineConnector(definition: ConnectorDefinition): Connector {
  const diagnostics = validateConnector(definition);
  if (diagnostics.some((d) => d.severity === "error")) throw new DiagnosticsError("connector definition is invalid", diagnostics);

  const operations: Record<string, Operation> = Object.create(null) as Record<string, Operation>;
  const table = new Map<string, CompiledOperation>();
  const auth: AuthSpec =
    definition.auth.kind === "oauth2"
      ? Object.freeze({ kind: "oauth2", scopes: Object.freeze([...definition.auth.scopes]), ...(definition.auth.hosts !== undefined ? { hosts: Object.freeze([...definition.auth.hosts]) } : {}) })
      : definition.auth.kind === "apiKey"
        ? Object.freeze({ kind: "apiKey", ...(definition.auth.hosts !== undefined ? { hosts: Object.freeze([...definition.auth.hosts]) } : {}) })
        : Object.freeze({ kind: "none" });
  const credentialHosts = credentialHostsOf(auth, parsedRules(definition.egress));
  for (const name of Object.keys(definition.operations)) {
    const def = definition.operations[name]!;
    const egress = Object.freeze([...(def.egress ?? definition.egress)]);
    const operation: Operation = Object.freeze({
      title: def.title,
      ...(def.description !== undefined ? { description: def.description } : {}),
      effect: def.effect,
      input: frozenSchema(def.input),
      output: frozenSchema(def.output),
      idempotent: def.idempotent === true,
      ...(def.compensate !== undefined ? { compensate: def.compensate } : {}),
      irreversible: def.irreversible === true,
      riskFloor: def.riskFloor ?? "none",
      egress,
      ...(def.scopes !== undefined ? { scopes: Object.freeze([...def.scopes]) } : {}),
      ...(def.completion !== undefined ? { completion: Object.freeze({ windowMs: def.completion.windowMs }) } : {}),
      handler: def.handler,
    });
    Object.defineProperty(operations, name, { value: operation, enumerable: true });
    table.set(name, Object.freeze({ name, operation, rules: Object.freeze(parsedRules(egress)), credentialHosts }));
  }
  const connector: Connector = Object.freeze({
    id: definition.id,
    version: definition.version,
    title: definition.title,
    ...(definition.description !== undefined ? { description: definition.description } : {}),
    auth,
    egress: Object.freeze([...definition.egress]),
    operations: Object.freeze(operations),
    ...(definition.webhooks !== undefined ? { webhooks: Object.freeze({ verify: definition.webhooks.verify, parse: definition.webhooks.parse }) } : {}),
    ...(definition.propagateTrace === true ? { propagateTrace: true as const } : {}),
  });
  compiled.set(connector, Object.freeze({ connector, operations: table }));
  return connector;
}

/**
 * Internal: the parsed form of a connector. A connector that did not come
 * from `defineConnector` (another copy of this package, a hand-built
 * object) is validated and frozen first, and throws when invalid.
 */
export function compileConnector(connector: Connector): CompiledConnector {
  const known = compiled.get(connector);
  if (known) return known;
  const copy = compiled.get(defineConnector(connector as unknown as ConnectorDefinition))!;
  compiled.set(connector, copy);
  return copy;
}

/** The connector's manifest: everything except its handlers, as plain JSON. */
export function manifestOf(connector: Connector): ConnectorManifest {
  const c = compileConnector(connector).connector;
  const operations: Record<string, OperationManifest> = {};
  for (const name of Object.keys(c.operations).sort()) {
    const op = c.operations[name]!;
    operations[name] = {
      title: op.title,
      ...(op.description !== undefined ? { description: op.description } : {}),
      effect: op.effect,
      input: cloneJson(op.input as unknown as JsonValue) as unknown as JsonSchema,
      output: cloneJson(op.output as unknown as JsonValue) as unknown as JsonSchema,
      idempotent: op.idempotent,
      ...(op.compensate !== undefined ? { compensate: op.compensate } : {}),
      irreversible: op.irreversible,
      riskFloor: op.riskFloor,
      egress: [...op.egress],
      ...(op.scopes !== undefined ? { scopes: [...op.scopes] } : {}),
      ...(op.completion !== undefined ? { completion: { windowMs: op.completion.windowMs } } : {}),
    };
  }
  return {
    manifestVersion: MANIFEST_VERSION,
    id: c.id,
    version: c.version,
    title: c.title,
    ...(c.description !== undefined ? { description: c.description } : {}),
    auth:
      c.auth.kind === "oauth2"
        ? { kind: "oauth2", scopes: [...c.auth.scopes], ...(c.auth.hosts !== undefined ? { hosts: [...c.auth.hosts] } : {}) }
        : c.auth.kind === "apiKey"
          ? { kind: "apiKey", ...(c.auth.hosts !== undefined ? { hosts: [...c.auth.hosts] } : {}) }
          : { kind: "none" },
    egress: [...c.egress],
    operations,
    ...(c.webhooks !== undefined ? { webhooks: true as const } : {}),
    ...(c.propagateTrace === true ? { propagateTrace: true as const } : {}),
  };
}

/**
 * `sha256:<hex>` of the manifest's canonical JSON (sorted keys, no
 * whitespace). Equal manifests always have equal digests, so the digest can
 * be signed, pinned in a flow's catalog, or compared across deployments.
 */
export function manifestDigest(manifest: ConnectorManifest): string {
  const issue = checkJson(manifest);
  if (issue) throw new Error(`manifest is not plain JSON: ${issue.message}`);
  return `sha256:${toHex(sha256(canonicalJson(manifest as unknown as JsonValue)))}`;
}

/**
 * What one operation promises, as the contract's `OperationContract`: its
 * effect, idempotency, undo (`compensate` as an action id), risk floor,
 * schemas and, when it declares one, its completion window. Its
 * `operationDigest` is what a flow pins. Null for an unknown operation.
 */
export function operationContractOf(connector: Connector, operation: string): OperationContract | null {
  const c = compileConnector(connector);
  const op = c.operations.get(operation)?.operation;
  if (!op) return null;
  return {
    effect: op.effect,
    idempotent: op.idempotent,
    irreversible: op.irreversible,
    ...(op.compensate !== undefined ? { compensate: `${c.connector.id}.${op.compensate}` } : {}),
    riskFloor: op.riskFloor,
    input: cloneJson(op.input as unknown as JsonValue) as unknown as JsonSchema,
    output: cloneJson(op.output as unknown as JsonValue) as unknown as JsonSchema,
    ...(op.completion !== undefined ? { completion: { windowMs: op.completion.windowMs } } : {}),
  };
}

/**
 * Every operation contract of `connectors`, keyed by action id
 * (`<connectorId>.<operation>`): what `checkActionBindings` and
 * `pinActionContracts` in `@aaply/flow` take.
 */
export function operationContracts(connectors: readonly Connector[]): Record<string, OperationContract> {
  const out: Record<string, OperationContract> = {};
  for (const connector of connectors) {
    const c = compileConnector(connector);
    for (const name of c.operations.keys()) out[`${c.connector.id}.${name}`] = operationContractOf(c.connector, name)!;
  }
  return out;
}
