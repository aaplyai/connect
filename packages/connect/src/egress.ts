/**
 * Safe egress: the network check under every connection Connect opens.
 *
 * The kit checks each request against the operation's declared hosts and
 * paths. This checks where the socket really goes: names are resolved here,
 * and a socket is refused when any address the name resolves to is
 * loopback, private, link-local, cloud metadata, carrier-grade NAT,
 * multicast, reserved, or an IPv6 range that tunnels to one of those (NAT64,
 * 6to4, Teredo, unique-local). The check runs at connect time on the
 * addresses the socket then uses, so a name that changes its answer between
 * a check and the connection (DNS rebinding) cannot slip through.
 *
 * Private networks (Aaply's own database, say) are reached only through the
 * operator's allowlist: CIDRs or host names in deployment config, never
 * tenant data.
 */

import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { BlockList, isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import type { FetchLike } from "@aaply/connector-sdk";

const BLOCKED_V4 = [
  "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24",
  "192.88.99.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4",
];
const BLOCKED_V6 = [
  "::/96", "::1/128", "64:ff9b::/96", "64:ff9b:1::/48", "100::/64", "2001::/32", "2001:db8::/32", "2002::/16", "fc00::/7", "fe80::/10", "fec0::/10", "ff00::/8",
];

function blockList(cidrs: readonly string[]): BlockList {
  const list = new BlockList();
  for (const cidr of cidrs) {
    const [address, bits] = cidr.split("/");
    const type = isIP(address ?? "") === 6 ? "ipv6" : "ipv4";
    if (!address || isIP(address) === 0 || bits === undefined || !/^\d{1,3}$/.test(bits) || Number(bits) > (type === "ipv6" ? 128 : 32)) {
      throw new Error(`not a CIDR: ${cidr}`);
    }
    list.addSubnet(address, Number(bits), type);
  }
  return list;
}

const BLOCKED = blockList([...BLOCKED_V4, ...BLOCKED_V6]);

/** Operator settings for private networks. */
export interface EgressOptions {
  /** Sockets kept per origin (scheme, host and port) for connector requests. Default 64; calls beyond it wait for one. */
  connectionsPerOrigin?: number;
  /**
   * Private addresses Connect may reach anyway: CIDRs (`10.20.0.0/16`) and
   * exact host names (`db.internal.aaply.ai`). Deployment config only. A host
   * name here may resolve to any address, loopback and metadata included, so
   * list names only of hosts whose DNS the operator controls; prefer CIDRs.
   */
  allowPrivate?: readonly string[];
}

/** The egress policy: which addresses a socket may connect to. */
export interface EgressPolicy {
  /** Null when `address` (an IP) may be reached for `host`, or why not. */
  check(address: string, host: string): string | null;
  /** A `dns.lookup` replacement for sockets (`net.connect({ lookup })`): resolves, then refuses when any answer is blocked. */
  lookup: typeof dnsLookup;
}

/** An IPv4-mapped IPv6 address (`::ffff:10.0.0.1`) as its IPv4 address; anything else unchanged. */
function unmap(address: string): string {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  return m?.[1] ?? address;
}

export function egressPolicy(options: EgressOptions = {}): EgressPolicy {
  const cidrs = (options.allowPrivate ?? []).filter((entry) => entry.includes("/"));
  const hosts = new Set((options.allowPrivate ?? []).filter((entry) => !entry.includes("/")).map((h) => h.toLowerCase()));
  for (const h of hosts) if (!/^[a-z0-9.-]{1,253}$/.test(h)) throw new Error(`not a host name: ${h}`);
  const allowed = blockList(cidrs);
  const check = (raw: string, host: string): string | null => {
    const address = unmap(raw);
    const family = isIP(address);
    if (family === 0) return `not an IP address: ${raw}`;
    const type = family === 6 ? "ipv6" : "ipv4";
    // An IPv4-mapped address that is not a plain mapping (::ffff:0:0/96 in hex) is refused outright.
    if (type === "ipv6" && /^::ffff:/i.test(address)) return `${raw} is an IPv4-mapped address`;
    if (!BLOCKED.check(address, type)) return null;
    if (allowed.check(address, type) || hosts.has(host.toLowerCase())) return null;
    return `${raw} is a private or reserved address`;
  };
  const lookup = ((hostname: string, opts: unknown, callback?: unknown) => {
    const cb = (typeof opts === "function" ? opts : callback) as (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;
    const o = (typeof opts === "object" && opts !== null ? opts : typeof opts === "number" ? { family: opts } : {}) as { family?: number; all?: boolean };
    dnsLookup(hostname, { all: true, ...(o.family ? { family: o.family } : {}) }, (error, addresses) => {
      if (error) return cb(error, o.all ? [] : "");
      if (addresses.length === 0) return cb(Object.assign(new Error(`${hostname} has no address`), { code: "ENOTFOUND" }), o.all ? [] : "");
      for (const a of addresses) {
        const problem = check(a.address, hostname);
        if (problem) return cb(Object.assign(new Error(`egress refused: ${hostname}: ${problem}`), { code: "ECONNREFUSED", egressRefused: true }), o.all ? [] : "");
      }
      if (o.all) return cb(null, addresses);
      const first = addresses[0]!;
      cb(null, first.address, first.family);
    });
  }) as unknown as typeof dnsLookup;
  return { check, lookup };
}

/**
 * Whether an error came from the egress check. Such an error carries the code
 * `ECONNREFUSED`, which the kit counts as "nothing was sent": a refused write
 * is then `retryable` (`connect/network`), never `unknown`.
 */
export function isEgressRefusal(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    if ((e as { egressRefused?: unknown }).egressRefused === true) return true;
  }
  return false;
}

/** A `fetch` for the kit whose sockets pass the egress policy. Literal IP hosts are checked before anything is sent. */
export function safeFetch(policy: EgressPolicy, options: { connections?: number } = {}): { fetch: FetchLike; close(): Promise<void> } {
  const agent = new Agent({ connect: { lookup: policy.lookup }, connections: options.connections ?? 64, keepAliveTimeout: 10_000 });
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (isIP(host) !== 0) {
      const problem = policy.check(host, host);
      if (problem) throw Object.assign(new TypeError(`fetch failed`), { cause: Object.assign(new Error(`egress refused: ${problem}`), { code: "ECONNREFUSED", egressRefused: true }) });
    }
    return (await undiciFetch(input, { ...(init as object), dispatcher: agent } as Parameters<typeof undiciFetch>[1])) as unknown as Response;
  };
  return { fetch, close: () => agent.close() };
}
