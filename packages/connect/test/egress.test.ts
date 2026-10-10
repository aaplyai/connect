import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { egressPolicy } from "@aaply/connect";
import { isEgressRefusal, safeFetch } from "../src/egress.js";

describe("the egress policy", () => {
  const policy = egressPolicy();

  it("refuses loopback, private, link-local, metadata, CGNAT, multicast and reserved addresses", () => {
    for (const a of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "240.0.0.1", "255.255.255.255", "198.18.0.1"]) {
      expect(policy.check(a, "h"), a).not.toBeNull();
    }
  });

  it("refuses IPv6 loopback, unique-local, link-local and ranges that tunnel to IPv4", () => {
    for (const a of ["::1", "::", "fc00::1", "fd12::1", "fe80::1", "ff02::1", "64:ff9b::a00:1", "2002:a00:1::", "2001:0:4136::1", "::ffff:127.0.0.1", "::ffff:a00:1", "::a00:1"]) {
      expect(policy.check(a, "h"), a).not.toBeNull();
    }
  });

  it("allows public addresses, an IPv4-mapped public one included", () => {
    for (const a of ["8.8.8.8", "142.250.0.1", "2607:f8b0:4004::1", "::ffff:8.8.8.8"]) expect(policy.check(a, "h"), a).toBeNull();
  });

  it("allows private addresses only through the operator's allowlist, by CIDR or by exact host", () => {
    const allowing = egressPolicy({ allowPrivate: ["10.20.0.0/16", "db.internal.example"] });
    expect(allowing.check("10.20.1.1", "x")).toBeNull();
    expect(allowing.check("10.21.1.1", "x")).not.toBeNull();
    expect(allowing.check("192.168.1.1", "DB.internal.example")).toBeNull();
    expect(allowing.check("192.168.1.1", "other.internal.example")).not.toBeNull();
    expect(() => egressPolicy({ allowPrivate: ["10.0.0.0/40"] })).toThrow(/CIDR/);
  });

  it("refuses at connect time a name that resolves to a blocked address", async () => {
    const error = await new Promise<Error | null>((resolve) => policy.lookup("localhost", { all: true }, (e) => resolve(e)));
    expect(error?.message).toMatch(/egress refused/);
  });

  it("never sends a request to a blocked address, and says so as nothing sent", async () => {
    let hits = 0;
    const server = createServer((_req, res) => (hits++, res.end("{}")));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const blocked = safeFetch(policy);
    const open = safeFetch(egressPolicy({ allowPrivate: ["127.0.0.0/8", "localhost"] }));
    try {
      for (const url of [`http://127.0.0.1:${port}/`, `http://localhost:${port}/`, "http://[::1]:9/", "http://169.254.169.254/latest/meta-data"]) {
        const error = await blocked.fetch(url, { method: "POST" }).then(() => null, (e: unknown) => e);
        expect(isEgressRefusal(error), url).toBe(true);
      }
      expect(hits).toBe(0);
      expect((await open.fetch(`http://127.0.0.1:${port}/`, {})).status).toBe(200);
      expect((await open.fetch(`http://localhost:${port}/`, {})).status).toBe(200);
      expect(hits).toBe(2);
    } finally {
      await blocked.close();
      await open.close();
      server.close();
    }
  });
});
