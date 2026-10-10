import type { JsonValue } from "@aaply/action-contract";
import { describe, expect, it } from "vitest";
import { ConnectorError, defineConnector, type EgressRule, type HttpRequest } from "../src/index.js";
import { checkEgress, parseEgressRule, ruleCovers } from "../src/egress.js";
import { mockFetch, testConnector } from "../src/testing.js";
import { exampleNotes } from "./fixtures/example-notes.js";
import { notesBackend } from "./fixtures/notes-backend.js";

function rule(source: string): EgressRule {
  const parsed = parseEgressRule(source);
  if ("issue" in parsed) throw new Error(parsed.issue.message);
  return parsed.rule;
}

/** A connector whose operations just make the request they are given. */
const relay = defineConnector({
  id: "relay",
  version: "0.1.0",
  title: "Relay",
  auth: { kind: "apiKey", hosts: ["api.example.com"] },
  egress: ["GET api.example.com/v1/*", "POST api.example.com/v1/items", "GET files.example-cdn.com/*", "GET *.tenant.example.net/data/*"],
  operations: {
    fetch: {
      title: "Fetch",
      effect: "read",
      input: { type: "object", required: ["request"], properties: { request: { type: "object" } } },
      output: {},
      async handler(input: { request: JsonValue }, ctx) {
        const res = await ctx.http(input.request as unknown as HttpRequest);
        return { status: res.status, url: res.url, redirects: res.redirects, body: res.text() };
      },
    },
    send: {
      title: "Send",
      effect: "write",
      irreversible: true,
      input: { type: "object", required: ["request"], properties: { request: { type: "object" } } },
      output: {},
      egress: ["POST api.example.com/v1/items", "GET api.example.com/v1/*"],
      async handler(input: { request: JsonValue }, ctx) {
        const res = await ctx.http(input.request as unknown as HttpRequest);
        return { status: res.status };
      },
    },
  },
});

async function refusal(promise: Promise<unknown>): Promise<ConnectorError> {
  try {
    await promise;
  } catch (error) {
    if (ConnectorError.is(error)) return error;
    throw error;
  }
  throw new Error("expected a ConnectorError");
}

describe("egress rules", () => {
  it("match method, host and path exactly or by prefix", () => {
    const rules = [rule("GET api.example.com/v1/notes"), rule("GET api.example.com/v1/notes/*"), rule("GET *.example.org/x/*")];
    const allowed = (method: string, url: string) => checkEgress(rules, method, url).ok;
    expect(allowed("GET", "https://api.example.com/v1/notes")).toBe(true);
    expect(allowed("GET", "https://api.example.com/v1/notes?limit=5")).toBe(true);
    expect(allowed("GET", "https://api.example.com/v1/notes/abc")).toBe(true);
    expect(allowed("GET", "https://api.example.com/v1/notesX")).toBe(false);
    expect(allowed("POST", "https://api.example.com/v1/notes")).toBe(false);
    expect(allowed("GET", "https://eu.example.org/x/1")).toBe(true);
    expect(allowed("GET", "https://a.b.example.org/x/1")).toBe(true);
    expect(allowed("GET", "https://example.org/x/1")).toBe(false);
    expect(allowed("GET", "https://evilexample.org/x/1")).toBe(false);
    expect(allowed("GET", "https://api.example.com.evil.net/v1/notes")).toBe(false);
  });

  it("refuse URLs that are not https, carry credentials, use another port or an address", () => {
    const rules = [rule("GET api.example.com/*")];
    const code = (url: string) => {
      const r = checkEgress(rules, "GET", url);
      return r.ok ? "ok" : r.code;
    };
    expect(code("http://api.example.com/x")).toBe("connect/egress-not-https");
    expect(code("https://user:pw@api.example.com/x")).toBe("connect/egress-forbidden-host");
    expect(code("https://api.example.com:8443/x")).toBe("connect/egress-forbidden-host");
    expect(code("https://api.example.com:443/x")).toBe("ok");
    expect(code("https://127.0.0.1/x")).toBe("connect/egress-forbidden-host");
    expect(code("https://0x7f.1/x")).toBe("connect/egress-forbidden-host");
    expect(code("https://[::1]/x")).toBe("connect/egress-forbidden-host");
    expect(code("https://169.254.169.254/latest/meta-data")).toBe("connect/egress-forbidden-host");
    expect(code("https://localhost/x")).toBe("connect/egress-forbidden-host");
    expect(code("https://api.example.com/v1/..%2f..%2fadmin")).toBe("connect/egress-denied");
    expect(code("not a url")).toBe("connect/bad-request");
  });

  it("cover narrower rules only", () => {
    expect(ruleCovers(rule("GET api.example.com/v1/*"), rule("GET api.example.com/v1/notes/*"))).toBe(true);
    expect(ruleCovers(rule("GET api.example.com/v1/*"), rule("GET api.example.com/v2/notes"))).toBe(false);
    expect(ruleCovers(rule("GET api.example.com/v1/notes"), rule("GET api.example.com/v1/notes/*"))).toBe(false);
    expect(ruleCovers(rule("GET *.example.com/*"), rule("GET *.eu.example.com/*"))).toBe(true);
    expect(ruleCovers(rule("GET api.example.com/*"), rule("POST api.example.com/*"))).toBe(false);
  });
});

describe("ctx.http", () => {
  it("allows declared requests and injects the credential as a header", async () => {
    const fetch = mockFetch({ "GET https://api.example.com/v1/things": { json: { ok: true } } });
    const t = testConnector(relay, { fetch, credentials: { "x-api-key": "secret-key-123" } });
    const out = await t.run("fetch", { request: { url: "https://api.example.com/v1/things", query: { q: "a b", n: 2 } } });
    expect(out).toMatchObject({ status: 200, body: '{"ok":true}' });
    await t.http("fetch", { url: "https://api.example.com/v1/things", query: { skip: undefined, none: null, flag: true } });
    expect(fetch.calls).toHaveLength(2);
    expect(fetch.calls.map((c) => c.url)).toEqual(["https://api.example.com/v1/things?q=a+b&n=2", "https://api.example.com/v1/things?flag=true"]);
    expect(fetch.calls[0]!.headers["x-api-key"]).toBe("secret-key-123");
    expect(fetch.calls[0]!.headers["user-agent"]).toBe("aaply-connector (relay/0.1.0)");
  });

  it.each<[string, HttpRequest, string]>([
    ["an undeclared host", { url: "https://api.example.org/v1/things" }, "connect/egress-denied"],
    ["an undeclared path", { url: "https://api.example.com/v2/things" }, "connect/egress-denied"],
    ["an undeclared method", { method: "DELETE", url: "https://api.example.com/v1/things" }, "connect/egress-denied"],
    ["plain http", { url: "http://api.example.com/v1/things" }, "connect/egress-not-https"],
    ["an IPv4 address", { url: "https://10.0.0.5/v1/things" }, "connect/egress-forbidden-host"],
    ["an IPv6 address", { url: "https://[fd00::1]/v1/things" }, "connect/egress-forbidden-host"],
    ["link-local metadata", { url: "https://169.254.169.254/latest/meta-data/" }, "connect/egress-forbidden-host"],
    ["another port", { url: "https://api.example.com:8443/v1/things" }, "connect/egress-forbidden-host"],
    ["credentials in the URL", { url: "https://me:pw@api.example.com/v1/things" }, "connect/egress-forbidden-host"],
    ["a platform header", { url: "https://api.example.com/v1/things", headers: { host: "internal.example.com" } }, "connect/bad-request"],
    ["a body on GET", { url: "https://api.example.com/v1/things", body: "x" }, "connect/bad-request"],
    ["an unknown method", { method: "TRACE", url: "https://api.example.com/v1/things" }, "connect/bad-request"],
  ])("refuses %s without calling fetch", async (_name, request, code) => {
    const fetch = mockFetch({});
    const t = testConnector(relay, { fetch });
    const error = await refusal(t.http("fetch", request));
    expect(error.code).toBe(code);
    expect(error.kind).toBe("final");
    expect(fetch.calls).toHaveLength(0);
    expect(t.logs.filter((l) => l.event === "http.refused").length).toBe(code === "connect/bad-request" ? 0 : 1);
  });

  it("honours wildcard hosts", async () => {
    const fetch = mockFetch({ "GET https://acme.tenant.example.net/data/*": { json: [] } });
    const t = testConnector(relay, { fetch });
    await expect(t.http("fetch", { url: "https://acme.tenant.example.net/data/1" })).resolves.toMatchObject({ status: 200 });
    expect((await refusal(t.http("fetch", { url: "https://tenant.example.net/data/1" }))).code).toBe("connect/egress-denied");
  });

  it("uses the operation's own narrower egress", async () => {
    const t = testConnector(relay, { fetch: mockFetch({}) });
    expect((await refusal(t.http("send", { url: "https://files.example-cdn.com/a" }))).code).toBe("connect/egress-denied");
  });

  describe("redirects", () => {
    it("re-checks every hop and refuses a redirect to another host", async () => {
      const fetch = mockFetch({ "GET https://api.example.com/v1/start": { status: 302, headers: { location: "https://evil.example.org/steal" } } });
      const t = testConnector(relay, { fetch });
      const outcome = await t.call("fetch", { request: { url: "https://api.example.com/v1/start" } });
      expect(outcome).toEqual({ status: "final", error: { code: "connect/egress-denied", message: expect.stringContaining("evil.example.org") } });
      expect(fetch.calls.map((c) => c.url)).toEqual(["https://api.example.com/v1/start"]);
    });

    it("refuses a redirect to an internal address or to plain http", async () => {
      const fetch = mockFetch({
        "GET https://api.example.com/v1/a": { status: 307, headers: { location: "https://169.254.169.254/latest/meta-data/" } },
        "GET https://api.example.com/v1/b": { status: 301, headers: { location: "http://api.example.com/v1/c" } },
      });
      const t = testConnector(relay, { fetch });
      expect((await refusal(t.http("fetch", { url: "https://api.example.com/v1/a" }))).code).toBe("connect/egress-forbidden-host");
      expect((await refusal(t.http("fetch", { url: "https://api.example.com/v1/b" }))).code).toBe("connect/egress-not-https");
      expect(fetch.calls).toHaveLength(2);
    });

    it("follows declared redirects, keeping the credential on the same origin only", async () => {
      const fetch = mockFetch({
        "GET https://api.example.com/v1/file": { status: 302, headers: { location: "/v1/file-v2" } },
        "GET https://api.example.com/v1/file-v2": { status: 307, headers: { location: "https://files.example-cdn.com/blob/1?sig=abc" } },
        "GET https://files.example-cdn.com/blob/*": { body: "file contents" },
      });
      const t = testConnector(relay, { fetch, credentials: { authorization: "Bearer very-secret" } });
      const res = await t.http("fetch", { url: "https://api.example.com/v1/file", headers: { cookie: "a=b" } });
      expect(res).toMatchObject({ status: 200, redirects: 2, url: "https://files.example-cdn.com/blob/1?sig=abc" });
      expect(res.text()).toBe("file contents");
      expect(fetch.calls.map((c) => c.headers.authorization)).toEqual(["Bearer very-secret", "Bearer very-secret", undefined]);
      expect(fetch.calls[2]!.headers.cookie).toBeUndefined();
    });

    it("turns POST into GET on 303 and stops after too many hops", async () => {
      const fetch = mockFetch({
        "POST https://api.example.com/v1/items": { status: 303, headers: { location: "/v1/items/9" } },
        "GET https://api.example.com/v1/items/9": { json: { id: "9" } },
        "GET https://api.example.com/v1/loop": { status: 302, headers: { location: "/v1/loop" } },
      });
      const t = testConnector(relay, { fetch });
      const res = await t.http("fetch", { method: "POST", url: "https://api.example.com/v1/items", json: { a: 1 } });
      expect(res.json()).toEqual({ id: "9" });
      expect(fetch.calls.map((c) => [c.method, c.body])).toEqual([
        ["POST", '{"a":1}'],
        ["GET", null],
      ]);
      expect((await refusal(t.http("fetch", { url: "https://api.example.com/v1/loop" }))).code).toBe("connect/too-many-redirects");
    });
  });

  describe("limits", () => {
    it("caps the response size, by declared length and while streaming", async () => {
      const big = "x".repeat(2048);
      const stream = () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (let i = 0; i < 4; i++) controller.enqueue(new TextEncoder().encode(big));
              controller.close();
            },
          }),
        );
      const fetch = mockFetch({
        "GET https://api.example.com/v1/declared": { headers: { "content-length": "999999" }, body: "small" },
        "GET https://api.example.com/v1/streamed": () => stream(),
      });
      const t = testConnector(relay, { fetch, limits: { maxResponseBytes: 4096 } });
      expect((await refusal(t.http("fetch", { url: "https://api.example.com/v1/declared" }))).code).toBe("connect/response-too-large");
      expect((await refusal(t.http("fetch", { url: "https://api.example.com/v1/streamed" }))).code).toBe("connect/response-too-large");
      // A call may lower the cap, never raise it.
      expect((await refusal(t.http("fetch", { url: "https://api.example.com/v1/streamed", maxResponseBytes: 100_000 }))).code).toBe("connect/response-too-large");
      fetch.on("GET https://api.example.com/v1/small", { body: "12345" });
      expect((await refusal(t.http("fetch", { url: "https://api.example.com/v1/small", maxResponseBytes: 4 }))).code).toBe("connect/response-too-large");
      expect((await t.http("fetch", { url: "https://api.example.com/v1/small", maxResponseBytes: 5 })).text()).toBe("12345");
    });

    it("bounds each call by its timeout and the operation's deadline", async () => {
      const fetch = mockFetch({ "GET https://api.example.com/v1/slow": { hang: true }, "POST https://api.example.com/v1/items": { hang: true } });
      const t = testConnector(relay, { fetch });
      const perCall = await refusal(t.http("fetch", { url: "https://api.example.com/v1/slow", timeoutMs: 20 }));
      expect([perCall.kind, perCall.code]).toEqual(["retryable", "connect/timeout"]);
      const read = await t.call("fetch", { request: { url: "https://api.example.com/v1/slow" } }, { timeoutMs: 30 });
      expect(read).toMatchObject({ status: "retryable", error: { code: "connect/timeout" } });
      const write = await t.call("send", { request: { method: "POST", url: "https://api.example.com/v1/items", json: {} } }, { timeoutMs: 30 });
      expect(write).toMatchObject({ status: "unknown", error: { code: "connect/timeout" } });
    });

    it("caps requests per operation call", async () => {
      const looping = defineConnector({
        id: "looping",
        version: "1.0.0",
        title: "Looping",
        auth: { kind: "none" },
        egress: ["GET api.example.com/v1/page"],
        operations: {
          all: {
            title: "All pages",
            effect: "read",
            input: { type: "object" },
            output: {},
            async handler(_input, ctx) {
              for (;;) await ctx.http({ url: "https://api.example.com/v1/page" });
            },
          },
        },
      });
      const fetch = mockFetch({ "GET https://api.example.com/v1/page": { json: {} } });
      const outcome = await testConnector(looping, { fetch, limits: { maxRequestsPerCall: 3 } }).call("all", {});
      expect(outcome).toMatchObject({ status: "final", error: { code: "connect/too-many-requests" } });
      expect(fetch.calls).toHaveLength(3);
    });
  });
});

describe("credentials", () => {
  it("are injected for the service but never visible to the handler, its output or its logs", async () => {
    const backend = notesBackend({ token: "tok-SECRET-42" });
    const seen: string[] = [];
    const spy = defineConnector({
      ...exampleNotes,
      operations: {
        ...exampleNotes.operations,
        list: {
          ...exampleNotes.operations.list!,
          async handler(input, ctx) {
            seen.push(JSON.stringify(ctx), JSON.stringify(Object.getOwnPropertyNames(ctx)), String(ctx.http));
            const res = await ctx.http({ url: "https://api.example.com/v1/notes" });
            seen.push(JSON.stringify([...res.headers]), res.text());
            return exampleNotes.operations.list!.handler(input, ctx);
          },
        },
      },
    });
    const t = testConnector(spy, { fetch: backend.fetch, credentials: { authorization: "Bearer tok-SECRET-42" } });
    const outcome = await t.call("list", {});
    expect(outcome.status).toBe("ok");
    expect(backend.fetch.calls.every((c) => c.headers.authorization === "Bearer tok-SECRET-42")).toBe(true);
    const everything = JSON.stringify({ seen, outcome, logs: t.logs });
    expect(everything).not.toContain("tok-SECRET-42");
  });

  it("are fetched lazily, once per call, and not at all for auth none or auth: false", async () => {
    let asked = 0;
    const fetch = mockFetch({ "GET https://api.example.com/v1/x": { json: {} } });
    const provider = async () => {
      asked++;
      return { authorization: "Bearer t" };
    };
    const { HttpSession } = await import("../src/http.js");
    const { createConnectorLog } = await import("../src/log.js");
    const session = new HttpSession({
      fetch,
      rules: [rule("GET api.example.com/v1/x")],
      effect: "read",
      signal: new AbortController().signal,
      deadline: Date.now() + 5000,
      clock: { now: () => Date.now() },
      credentials: provider,
      limits: { maxResponseBytes: 1000, maxRequestBytes: 1000, maxRedirects: 2, maxRequestsPerCall: 10 },
      userAgent: "test",
      log: createConnectorLog(undefined, { connectorId: "x", operation: "y", connectionId: null }),
    });
    await session.http({ url: "https://api.example.com/v1/x", auth: false });
    expect(asked).toBe(0);
    expect(fetch.calls[0]!.headers.authorization).toBeUndefined();
    await session.http({ url: "https://api.example.com/v1/x" });
    expect(asked).toBe(1);

    const open = defineConnector({ ...relay, id: "open-relay", auth: { kind: "none" } });
    const t = testConnector(open, { fetch, credentials: { authorization: "Bearer should-not-be-sent" } });
    await t.http("fetch", { url: "https://api.example.com/v1/x" });
    expect(fetch.calls.at(-1)!.headers.authorization).toBeUndefined();
  });

  it("override a header of the same name set by the handler", async () => {
    const fetch = mockFetch({ "GET https://api.example.com/v1/x": { json: {} } });
    const t = testConnector(relay, { fetch, credentials: { authorization: "Bearer real" } });
    await t.http("fetch", { url: "https://api.example.com/v1/x", headers: { Authorization: "Bearer forged" } });
    expect(fetch.calls[0]!.headers.authorization).toBe("Bearer real");
  });
});
