/**
 * Declared egress: the only places a connector's operations may call.
 *
 * A rule is `METHOD host/path`, for example `GET api.example.com/v1/notes/*`.
 * Every call is https on the default port, so rules carry no scheme and no
 * port. The host is an exact name or a leading `*.` wildcard (any subdomain,
 * one or more labels deep, never the base name itself). The path is exact,
 * or a prefix when it ends in `*`. Queries are not part of a rule.
 *
 * Rules are checked twice: when a connector is defined (format, no IP
 * literals, no loopback, private or link-local names) and on every request
 * and redirect hop (the URL must be https, on the default port, without
 * credentials, and covered by one of the operation's rules).
 *
 * Name checks cannot see where DNS points. A host that resolves to a private
 * address must still be stopped by the network layer the platform runs
 * connectors behind; these checks are the declaration half of that contract.
 */

import { deepFreeze, frozenSet } from "@aaply/action-contract/internal";

export const EGRESS_METHODS = deepFreeze(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const);
export type EgressMethod = (typeof EGRESS_METHODS)[number];

/** Methods that never change anything on the server (RFC 9110 safe methods). */
export const SAFE_METHODS: ReadonlySet<string> = frozenSet(["GET", "HEAD"]);

export interface EgressRule {
  /** The rule as written. */
  readonly source: string;
  readonly method: EgressMethod;
  /** Lowercase host; for a wildcard rule, the base name after `*.`. */
  readonly host: string;
  readonly wildcard: boolean;
  /** The path, without the trailing `*` of a prefix rule. */
  readonly path: string;
  readonly prefix: boolean;
}

export interface EgressIssue {
  code: string;
  message: string;
}

const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PATH_RE = /^[A-Za-z0-9\-._~!$&'()+,;=:@/%]*$/;
const ENCODED_DOT_OR_SLASH_RE = /%(?:2e|2f|5c)/i;
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

/**
 * Names that point inside a network or back at the machine itself, plus
 * public wildcard-DNS services that answer with any address embedded in the
 * name. Matched as the whole name or a suffix after a dot.
 */
const PRIVATE_SUFFIXES: readonly string[] = [
  "localhost",
  "local",
  "localdomain",
  "internal",
  "intranet",
  "corp",
  "lan",
  "home",
  "private",
  "home.arpa",
  "in-addr.arpa",
  "ip6.arpa",
  "nip.io",
  "sslip.io",
  "xip.io",
  "localtest.me",
  "lvh.me",
  "vcap.me",
  "traefik.me",
];

const MAX_HOST_LENGTH = 253;
const MAX_RULE_LENGTH = 512;

/**
 * Whether a host name is an IP literal as a URL parser would read it: an
 * IPv6 literal, or a name whose last label is a number (decimal or `0x`
 * hex), which WHATWG URL parsing turns into an IPv4 address.
 */
export function isIpLiteral(host: string): boolean {
  if (host.startsWith("[") || host.includes(":")) return true;
  const labels = host.endsWith(".") ? host.slice(0, -1).split(".") : host.split(".");
  const last = labels[labels.length - 1] ?? "";
  return /^(?:0x[0-9a-f]*|\d+)$/i.test(last);
}

/** Why a host may never be called, or `null`. `host` is lowercase, without port. */
export function forbiddenHost(host: string): EgressIssue | null {
  if (host.length === 0) return { code: "host", message: "the host is empty" };
  if (isIpLiteral(host)) return { code: "ip-literal", message: "IP addresses are not allowed; name the service by its host name" };
  const name = host.endsWith(".") ? host.slice(0, -1) : host;
  for (const suffix of PRIVATE_SUFFIXES) {
    if (name === suffix || name.endsWith(`.${suffix}`)) {
      return { code: "private-host", message: `"${host}" is a loopback, private or link-local name` };
    }
  }
  if (!name.includes(".")) return { code: "private-host", message: `"${host}" is not a fully qualified public name` };
  return null;
}

function issue(code: string, message: string): { issue: EgressIssue } {
  return { issue: { code: `connector/${code}`, message } };
}

/** A rule's host, after its port: an exact lowercase name or a leading `*.` wildcard, never an address or a private name. */
function parseHostPart(source: string): HostPattern | { issue: EgressIssue } {
  let host = source;
  if (host !== host.toLowerCase()) return issue("egress-host", "write host names in lowercase");
  let wildcard = false;
  if (host.startsWith("*.")) {
    wildcard = true;
    host = host.slice(2);
  }
  if (host.includes("*")) return issue("egress-wildcard", 'only a leading "*." wildcard is allowed in a host');
  if (host.endsWith(".")) return issue("egress-host", "leave out the trailing dot");
  if (isIpLiteral(host)) return issue("egress-ip-literal", "IP addresses are not allowed; name the service by its host name");
  const labels = host.split(".");
  if (host.length > MAX_HOST_LENGTH || labels.some((l) => !LABEL_RE.test(l))) return issue("egress-host", `"${host}" is not a valid host name`);
  const forbidden = forbiddenHost(host);
  if (forbidden) {
    if (wildcard && forbidden.message.includes("fully qualified")) {
      return issue("egress-wildcard", `"*.${host}" is too broad; a wildcard needs a registered domain such as *.example.com`);
    }
    return issue(`egress-${forbidden.code}`, forbidden.message);
  }
  return { host, wildcard };
}

/**
 * A host name as a rule or a connector's `auth.hosts` writes it: an exact
 * lowercase name, or (`wildcard`) any subdomain of `host`, one or more
 * labels deep, never `host` itself.
 */
export interface HostPattern {
  readonly host: string;
  readonly wildcard: boolean;
}

/**
 * Parses one credential host (`auth.hosts`): a host name such as
 * `api.example.com` or `*.example.com`, checked as a rule's host is, with no
 * scheme, port or path. Issue codes are the `connector/egress-*` ones.
 */
export function parseHostPattern(source: unknown): { pattern: HostPattern } | { issue: EgressIssue } {
  if (typeof source !== "string" || source.length === 0 || source.length > MAX_HOST_LENGTH + 2 || /[\s/:@?#[\]]/.test(source)) {
    return issue("egress-host", 'a credential host is a host name such as "api.example.com" or "*.example.com", without scheme, port or path');
  }
  const parsed = parseHostPart(source);
  return "issue" in parsed ? parsed : { pattern: Object.freeze({ host: parsed.host, wildcard: parsed.wildcard }) };
}

/** Whether `pattern` matches `hostname` (a URL's lowercase host). */
export function hostMatches(pattern: HostPattern, hostname: string): boolean {
  return pattern.wildcard ? hostname.endsWith(`.${pattern.host}`) : hostname === pattern.host;
}

/** Parses and checks one rule. Issue codes are the stable `connector/egress-*` diagnostics. */
export function parseEgressRule(source: unknown): { rule: EgressRule } | { issue: EgressIssue } {
  if (typeof source !== "string" || source.length === 0 || source.length > MAX_RULE_LENGTH) {
    return issue("egress-format", `an egress rule is a string of at most ${MAX_RULE_LENGTH} characters, e.g. "GET api.example.com/v1/items/*"`);
  }
  const parts = source.split(" ");
  if (parts.length !== 2 || /\s/.test(parts[1]!) || /\s/.test(parts[0]!)) {
    return issue("egress-format", 'write a rule as "METHOD host/path", e.g. "GET api.example.com/v1/items/*"');
  }
  const [method, target] = parts as [string, string];
  if (!(EGRESS_METHODS as readonly string[]).includes(method)) {
    return issue("egress-method", `method must be one of ${EGRESS_METHODS.join(", ")} (uppercase)`);
  }
  const scheme = SCHEME_RE.exec(target);
  if (scheme) {
    const lower = scheme[0].toLowerCase();
    return issue(
      lower === "http://" ? "egress-not-https" : "egress-scheme",
      lower === "http://" ? "only https is allowed; write the rule without a scheme" : lower === "https://" ? "write the rule without a scheme; https is implied" : "only https is allowed",
    );
  }
  const slash = target.indexOf("/");
  if (slash <= 0) return issue("egress-format", "a rule needs a host and a path, e.g. api.example.com/v1/items/*");
  const hostPart = target.slice(0, slash);
  const path = target.slice(slash);

  if (hostPart.includes("@")) return issue("egress-credentials", "rules may not carry credentials; the platform injects them");
  if (hostPart.startsWith("[")) return issue("egress-ip-literal", "IP addresses are not allowed; name the service by its host name");
  let host = hostPart;
  const colon = hostPart.lastIndexOf(":");
  if (colon >= 0) {
    const port = hostPart.slice(colon + 1);
    if (port !== "443") return issue("egress-port", "only the default https port (443) is allowed");
    host = hostPart.slice(0, colon);
  }
  const parsedHost = parseHostPart(host);
  if ("issue" in parsedHost) return parsedHost;
  const { wildcard } = parsedHost;
  host = parsedHost.host;

  if (!path.startsWith("/")) return issue("egress-path", "the path must start with /");
  const prefix = path.endsWith("*");
  const body = prefix ? path.slice(0, -1) : path;
  if (body.includes("*")) return issue("egress-path", 'a "*" may only end the path');
  if (body.includes("?") || body.includes("#")) return issue("egress-path", "rules match paths only; leave out the query and fragment");
  if (!PATH_RE.test(body)) return issue("egress-path", "the path has characters that must be percent-encoded");
  if (body.includes("//") || body.split("/").some((seg) => seg === "." || seg === "..")) return issue("egress-path", "the path may not contain empty or dot segments");
  if (ENCODED_DOT_OR_SLASH_RE.test(body)) return issue("egress-path", "the path may not contain encoded dots, slashes or backslashes");

  return { rule: Object.freeze({ source, method: method as EgressMethod, host, wildcard, path: body, prefix }) };
}

/** Whether every host `inner` matches is also matched by `outer`. */
export function hostCovers(outer: HostPattern, inner: HostPattern): boolean {
  if (!outer.wildcard) return !inner.wildcard && inner.host === outer.host;
  if (inner.wildcard && inner.host === outer.host) return true;
  return inner.host.endsWith(`.${outer.host}`);
}

/** Whether every request `inner` allows is also allowed by `outer`. */
export function ruleCovers(outer: EgressRule, inner: EgressRule): boolean {
  if (outer.method !== inner.method || !hostCovers(outer, inner)) return false;
  if (outer.prefix) return inner.path.startsWith(outer.path);
  return !inner.prefix && inner.path === outer.path;
}

/** Whether `rule` allows `method` on an already checked https URL. */
export function ruleMatches(rule: EgressRule, method: string, url: URL): boolean {
  if (rule.method !== method) return false;
  if (!hostMatches(rule, url.hostname)) return false;
  return rule.prefix ? url.pathname.startsWith(rule.path) : url.pathname === rule.path;
}

/** A request the egress check refused. Codes are stable (`connect/...`). */
export interface EgressRefusal {
  code: "connect/bad-request" | "connect/egress-not-https" | "connect/egress-forbidden-host" | "connect/egress-denied";
  message: string;
}

function decodedSegments(pathname: string): string[] | null {
  try {
    return decodeURIComponent(pathname).split("/");
  } catch {
    return null;
  }
}

/**
 * Checks one request (or redirect hop) against an operation's rules.
 * Returns the parsed URL when allowed.
 */
export function checkEgress(rules: readonly EgressRule[], method: string, target: string | URL): { ok: true; url: URL } | ({ ok: false } & EgressRefusal) {
  let url: URL;
  try {
    url = typeof target === "string" ? new URL(target) : new URL(target.href);
  } catch {
    return { ok: false, code: "connect/bad-request", message: "the URL is not valid" };
  }
  if (url.protocol !== "https:") return { ok: false, code: "connect/egress-not-https", message: `only https is allowed, not ${url.protocol.replace(/:$/, "")}` };
  if (url.username !== "" || url.password !== "") return { ok: false, code: "connect/egress-forbidden-host", message: "URLs may not carry credentials" };
  if (url.port !== "") return { ok: false, code: "connect/egress-forbidden-host", message: "only the default https port is allowed" };
  const forbidden = forbiddenHost(url.hostname);
  if (forbidden) return { ok: false, code: "connect/egress-forbidden-host", message: forbidden.message };
  const segments = decodedSegments(url.pathname);
  if (segments === null || segments.some((s) => s === "." || s === ".." || s.includes("\\"))) {
    return { ok: false, code: "connect/egress-denied", message: "the path contains encoded dot segments or backslashes" };
  }
  if (!rules.some((rule) => ruleMatches(rule, method, url))) {
    return { ok: false, code: "connect/egress-denied", message: `${method} ${url.hostname} is not in this operation's declared egress` };
  }
  return { ok: true, url };
}
