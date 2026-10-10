import { blobDigestSync, hmacActionSigner, makeBlobRef, signApprovedAction, type ApprovedAction, type BlobRef, type JsonObject, type JsonValue, type Scope } from "@aaply/action-contract";
import { CONFORMANCE_AUDIENCE, CONFORMANCE_SCOPE, blobPortConformance, conformanceVerifier, draftApprovedAction, CONFORMANCE_KEY } from "@aaply/action-contract/conformance";
import { describe, expect, it } from "vitest";
import {
  ConnectorError,
  DEFAULT_BLOB_LIMITS,
  createConnectorActionPort,
  defineConnector,
  memoryBlobStore,
  type BlobStore,
  type ConnectorBlobs,
  type MemoryBlobStore,
} from "../src/index.js";
import { invokeOperation } from "../src/invoke.js";
import { TEST_SCOPE, mockFetch, testConnector } from "../src/testing.js";

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const bytesOf = (value: string): Uint8Array => new TextEncoder().encode(value);
const OTHER: Scope = { ...TEST_SCOPE, tenantId: "tenant-other" };

/** Somewhere a handler can leave its `ctx.blobs`, to show it is closed afterwards. */
let leaked: ConnectorBlobs | null = null;
/** A reference a handler returns or reads without having been given it. */
let planted: unknown = null;

const fileRef = { blob: true } as const;

const files = defineConnector({
  id: "example-files",
  version: "1.0.0",
  title: "Example Files",
  auth: { kind: "none" },
  egress: ["POST files.example.com/upload"],
  operations: {
    store: {
      title: "Store text as a file",
      effect: "read",
      input: { type: "object", required: ["text"], properties: { text: { type: "string" }, name: { type: "string" }, mediaType: { type: "string" }, copies: { type: "integer" } } },
      output: { type: "object", required: ["files"], properties: { files: { type: "array", items: fileRef } } },
      async handler(input, ctx) {
        const { text: body, name, mediaType, copies } = input as { text: string; name?: string; mediaType?: string; copies?: number };
        const out: JsonValue[] = [];
        for (let i = 0; i < (copies ?? 1); i++) out.push((await ctx.blobs.put(bytesOf(body), { mediaType: mediaType ?? "text/plain", ...(name !== undefined ? { name } : {}) })) as unknown as JsonValue);
        return { files: out };
      },
    },
    storeTogether: {
      title: "Store several files at once",
      effect: "read",
      input: { type: "object", required: ["count"], properties: { count: { type: "integer" } } },
      output: { type: "object", properties: { files: { type: "array", items: fileRef } } },
      async handler(input, ctx) {
        const refs = await Promise.all(Array.from({ length: input.count as number }, (_, i) => ctx.blobs.put(bytesOf(`file ${i}`), { mediaType: "text/plain" })));
        return { files: refs as unknown as JsonValue[] };
      },
    },
    read: {
      title: "Read a file",
      effect: "read",
      input: { type: "object", required: ["file"], properties: { file: fileRef } },
      output: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
      async handler(input, ctx) {
        return { text: text(await ctx.blobs.get(input.file as unknown as BlobRef)) };
      },
    },
    readPlanted: {
      title: "Read a file the call was not given",
      effect: "read",
      input: { type: "object" },
      output: { type: "object" },
      async handler(_input, ctx) {
        return { text: text(await ctx.blobs.get(planted as BlobRef)) };
      },
    },
    echo: {
      title: "Return the file it was given",
      effect: "read",
      input: { type: "object", required: ["file"], properties: { file: fileRef } },
      output: { type: "object", required: ["file"], properties: { file: fileRef } },
      handler: (input) => ({ file: input.file! }),
    },
    returnPlanted: {
      title: "Return a file it was not given",
      effect: "read",
      input: { type: "object" },
      output: { type: "object" },
      handler: () => ({ file: planted as JsonValue }),
    },
    attach: {
      title: "Store a file and send it",
      effect: "write",
      idempotent: true,
      input: { type: "object", required: ["mode"], properties: { mode: { enum: ["ok", "planted", "throw", "defer", "big"] } } },
      output: {},
      async handler(input, ctx) {
        const ref = (await ctx.blobs.put(bytesOf("attachment"), { mediaType: "application/octet-stream", name: "a.bin" })) as unknown as JsonValue;
        if (input.mode === "throw") throw ConnectorError.final("files/refused", "The service refused the file.");
        if (input.mode === "defer") ctx.defer("job-1");
        if (input.mode === "planted") return { file: ref, other: planted as JsonValue };
        if (input.mode === "big") return { file: ref, padding: "x".repeat(2048) };
        return { file: ref };
      },
    },
    leak: {
      title: "Keep ctx.blobs past the call",
      effect: "read",
      input: { type: "object" },
      output: {},
      handler: (_input, ctx) => {
        leaked = ctx.blobs;
        return null;
      },
    },
    passThrough: {
      title: "Takes anything",
      effect: "read",
      input: { type: "object" },
      output: {},
      handler: () => null,
    },
  },
});

function tester(store: BlobStore | null = memoryBlobStore(), extra: Parameters<typeof testConnector>[1] = {}) {
  return testConnector(files, { ...(store ? { blobs: store } : {}), ...extra });
}

async function stored(store: MemoryBlobStore, value: string, scope: Scope = TEST_SCOPE): Promise<BlobRef> {
  const bytes = bytesOf(value);
  return store.put(scope, { bytes, digest: blobDigestSync(bytes), size: bytes.length, mediaType: "text/plain" }, { connectorId: "seed", operation: "seed", connectionId: "seed", effectId: null });
}

describe("ctx.blobs.put", () => {
  it("stores content in the call's scope and answers a reference bound to it that describes exactly those bytes", async () => {
    const store = memoryBlobStore();
    const t = tester(store);
    const outcome = await t.call("store", { text: "hello", name: " report‮.txt/../x ", mediaType: "Text/Plain; charset=utf-8" });
    expect(outcome.status).toBe("ok");
    const [ref] = (outcome as unknown as { output: { files: BlobRef[] } }).output.files;
    expect(ref).toEqual(makeBlobRef(TEST_SCOPE, { id: ref!.id, digest: blobDigestSync(bytesOf("hello")), size: 5, mediaType: "text/plain", name: "report.txt_.._x" }));
    expect(store.list(TEST_SCOPE)).toEqual([ref]);
    expect(store.list(OTHER)).toEqual([]);
    expect(store.deletes).toEqual([]);
  });

  it("refuses what is not bytes and a media type that is not one", async () => {
    const t = tester();
    expect(await t.call("store", { text: "x", mediaType: "not a type" })).toMatchObject({ status: "final", error: { code: "connect/blob-invalid" } });
    const odd = defineConnector({
      ...files,
      id: "odd-files",
      operations: { put: { title: "Put a string", effect: "read", input: { type: "object" }, output: {}, handler: async (_i, ctx) => (await ctx.blobs.put("text" as unknown as Uint8Array, { mediaType: "text/plain" })) as unknown as JsonValue } },
    });
    expect(await testConnector(odd, { blobs: memoryBlobStore() }).call("put", {})).toMatchObject({ status: "final", error: { code: "connect/blob-invalid" } });
  });

  it("enforces the limits on every put, before the store sees it", async () => {
    const store = memoryBlobStore();
    const big = tester(store, { blobLimits: { maxBlobBytes: 4 } });
    expect(await big.call("store", { text: "hello" })).toMatchObject({ status: "final", error: { code: "connect/blob-too-large" } });
    const many = tester(store, { blobLimits: { maxBlobsPerCall: 2 } });
    expect(await many.call("store", { text: "x", copies: 2 })).toMatchObject({ status: "ok" });
    expect(await many.call("store", { text: "x", copies: 3 })).toMatchObject({ status: "final", error: { code: "connect/blob-too-many" } });
    const total = tester(store, { blobLimits: { maxBlobBytesPerCall: 10 } });
    expect(await total.call("store", { text: "hello", copies: 2 })).toMatchObject({ status: "ok" });
    expect(await total.call("store", { text: "hello", copies: 3 })).toMatchObject({ status: "final", error: { code: "connect/blob-too-large" } });
    // Puts made together cannot pass the limit together.
    expect(await many.call("storeTogether", { count: 3 })).toMatchObject({ status: "final", error: { code: "connect/blob-too-many" } });
    // What the refused calls stored was deleted: only the two successful calls' files remain.
    expect(store.count).toBe(4);
    expect(DEFAULT_BLOB_LIMITS).toEqual({ maxBlobBytes: 25 * 1024 * 1024, maxBlobsPerCall: 20, maxBlobBytesPerCall: 64 * 1024 * 1024 });
  });

  it("refuses without a store, and when the store fails or answers a reference that does not describe the bytes", async () => {
    expect(await tester(null).call("store", { text: "x" })).toMatchObject({ status: "final", error: { code: "connect/blob-no-store" } });
    const failing: BlobStore = { ...memoryBlobStore(), put: () => Promise.reject(new Error("disk full")) };
    expect(await tester(failing).call("store", { text: "x" })).toMatchObject({ status: "retryable", error: { code: "connect/blob-unavailable" } });
    const quota: BlobStore = { ...memoryBlobStore(), put: () => Promise.reject(ConnectorError.final("files/quota", "The tenant's file quota is used up.")) };
    expect(await tester(quota).call("store", { text: "x" })).toMatchObject({ status: "final", error: { code: "files/quota" } });

    const inner = memoryBlobStore();
    const elsewhere: BlobStore = { ...inner, put: (_scope, content, context) => inner.put(OTHER, content, context) };
    expect(await tester(elsewhere).call("store", { text: "x" })).toMatchObject({ status: "final", error: { code: "connect/blob-corrupt" } });
    const lying: BlobStore = { ...inner, put: (scope, content, context) => inner.put(scope, { ...content, size: content.size + 1 }, context) };
    expect(await tester(lying).call("store", { text: "x" })).toMatchObject({ status: "final", error: { code: "connect/blob-corrupt" } });
    // The mis-described content was deleted from the scope it was put in.
    expect(inner.list(TEST_SCOPE)).toEqual([]);
  });
});

describe("ctx.blobs.get", () => {
  it("reads a reference the call was given, and one it stored", async () => {
    const store = memoryBlobStore();
    const ref = await stored(store, "given");
    const t = tester(store);
    expect(await t.call("read", { file: ref as unknown as JsonValue })).toEqual({ status: "ok", output: { text: "given" } });
    expect(await t.call("echo", { file: ref as unknown as JsonValue })).toEqual({ status: "ok", output: { file: ref } });
  });

  it("refuses a reference the call was not given, even one stored in its own scope", async () => {
    const store = memoryBlobStore();
    planted = await stored(store, "someone else's file in the same tenant");
    const t = tester(store);
    expect(await t.call("readPlanted", {})).toMatchObject({ status: "final", error: { code: "connect/blob-not-granted" } });
    planted = makeBlobRef(OTHER, { id: (planted as BlobRef).id, digest: (planted as BlobRef).digest, size: (planted as BlobRef).size, mediaType: "text/plain" });
    expect(await t.call("readPlanted", {})).toMatchObject({ status: "final", error: { code: "connect/blob-foreign" } });
    planted = { ...(planted as BlobRef), url: "https://files.example.com/x" };
    expect(await t.call("readPlanted", {})).toMatchObject({ status: "final", error: { code: "connect/blob-invalid" } });
  });

  it("refuses a reference whose content is gone or is not what it describes, and one too large to read", async () => {
    const store = memoryBlobStore();
    const ref = await stored(store, "content");
    const t = tester(store);
    await store.delete(TEST_SCOPE, ref, { connectorId: "x", operation: "x", connectionId: "x", effectId: null });
    expect(await t.call("read", { file: ref as unknown as JsonValue })).toMatchObject({ status: "final", error: { code: "connect/blob-not-found" } });
    const swapped: BlobStore = { ...store, get: async () => bytesOf("CONTENT") };
    expect(await tester(swapped).call("read", { file: ref as unknown as JsonValue })).toMatchObject({ status: "final", error: { code: "connect/blob-corrupt" } });
    const small = tester(store, { blobLimits: { maxBlobBytes: 3 } });
    expect(await small.call("read", { file: ref as unknown as JsonValue })).toMatchObject({ status: "final", error: { code: "connect/blob-too-large" } });
  });
});

describe("references in a call's input and output", () => {
  it("refuses an input naming another scope's reference, or a malformed one, before the handler runs", async () => {
    const store = memoryBlobStore();
    const foreign = await stored(store, "theirs", OTHER);
    const t = tester(store);
    expect(await t.call("read", { file: foreign as unknown as JsonValue })).toMatchObject({ status: "final", error: { code: "connect/invalid-input", message: expect.stringContaining("at file:") } });
    // Found anywhere, whatever the schema says there.
    expect(await t.call("passThrough", { deep: [{ x: foreign as unknown as JsonValue }] })).toMatchObject({ status: "final", error: { code: "connect/invalid-input", message: expect.stringContaining("at deep[0].x:") } });
    expect(await t.call("passThrough", { deep: { $blob: 1, id: "x" } })).toMatchObject({ status: "final", error: { code: "connect/invalid-input" } });
    expect(t.handlerCalls).toEqual([]);
  });

  it("refuses an output naming a reference the call was not given and did not store: final for a read, unknown for a write", async () => {
    const store = memoryBlobStore();
    planted = await stored(store, "not given");
    const t = tester(store);
    expect(await t.call("returnPlanted", {})).toMatchObject({ status: "final", error: { code: "connect/bad-output" } });
    expect(await t.call("attach", { mode: "planted" })).toMatchObject({ status: "unknown", error: { code: "connect/bad-output" } });
    planted = makeBlobRef(OTHER, { id: "x", digest: blobDigestSync(bytesOf("x")), size: 1, mediaType: "text/plain" });
    expect(await t.call("returnPlanted", {})).toMatchObject({ status: "final", error: { code: "connect/bad-output", message: expect.stringContaining("another workspace") } });
    planted = { $blob: 2 };
    expect(await t.call("returnPlanted", {})).toMatchObject({ status: "final", error: { code: "connect/bad-output", message: expect.stringContaining("malformed") } });
  });
});

describe("nothing a call stores is left behind", () => {
  it.each([
    ["the handler fails", "throw", { status: "final", error: { code: "files/refused" } }],
    ["the handler defers", "defer", { status: "pending", ref: "job-1" }],
    ["the output names something it may not", "planted", { status: "unknown", error: { code: "connect/bad-output" } }],
  ])("deletes what a call stored when %s", async (_name, mode, expected) => {
    const store = memoryBlobStore();
    planted = await stored(store, "planted");
    expect(await tester(store).call("attach", { mode })).toMatchObject(expected);
    expect(store.list(TEST_SCOPE).map((r) => r.id)).toEqual([(planted as BlobRef).id]);
    expect(store.deletes).toHaveLength(1);
  });

  it("deletes what a write stored when its output is withheld, and keeps what an answered output names", async () => {
    const store = memoryBlobStore();
    const run = (maxOutputBytes: number) =>
      invokeOperation(files, "attach", { mode: "big" }, { fetch: mockFetch(), deadline: Date.now() + 5000, idempotencyKey: "k", connection: { id: "c", role: null }, credentials: async () => ({}), maxOutputBytes, scope: TEST_SCOPE, blobs: store });
    expect(await run(1024)).toMatchObject({ status: "ok", output: null, withheld: { bytes: expect.any(Number) } });
    expect(store.count).toBe(0);
    expect(store.deletes).toHaveLength(1);
    const kept = await run(1024 * 1024);
    expect(kept).toMatchObject({ status: "ok", output: { file: { name: "a.bin" } } });
    expect(store.list(TEST_SCOPE)).toEqual([(kept as unknown as { output: { file: BlobRef } }).output.file]);
  });

  it("closes ctx.blobs when the call ends, and deletes a put that finished after it", async () => {
    const store = memoryBlobStore();
    const t = tester(store);
    expect(await t.call("leak", {})).toEqual({ status: "ok", output: null });
    await expect(leaked!.put(bytesOf("late"), { mediaType: "text/plain" })).rejects.toMatchObject({ code: "connect/closed" });
    expect(store.count).toBe(0);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow: BlobStore = { ...store, put: async (scope, content, context) => (await gate, store.put(scope, content, context)) };
    const outcome = await tester(slow, { timeoutMs: 20 }).call("store", { text: "slow" });
    expect(outcome).toMatchObject({ status: "retryable", error: { code: "connect/timeout" } });
    release();
    for (let i = 0; i < 20 && store.deletes.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(store.deletes).toHaveLength(1);
    expect(store.count).toBe(0);
  });

  it("reports a cleanup delete that fails, and still answers", async () => {
    const store = memoryBlobStore();
    const errors: string[] = [];
    const stubborn: BlobStore = { ...store, delete: () => Promise.reject(new Error("store down")) };
    const port = createConnectorActionPort({
      audience: CONFORMANCE_AUDIENCE,
      verifier: conformanceVerifier(),
      connectors: [files],
      connections: () => ({ connectionId: "c", grantedScopes: [] }),
      credentials: { headers: () => ({}) },
      fetch: mockFetch(),
      blobs: stubborn,
      observer: { error: (_e, where) => errors.push(where) },
    });
    const outcome = await port.run(await envelope("example-files.attach", "write", { mode: "throw" }));
    expect(outcome).toMatchObject({ status: "final", error: { code: "files/refused" } });
    expect(errors).toContain("connector-blobs:cleanup");
    expect(store.count).toBe(1);
  });
});

describe("an answer and its deadline", () => {
  /** Downloads an attachment, keeping a scratch copy it never names; `late` moves the clock past the deadline first. */
  const downloads = defineConnector({
    id: "example-downloads",
    version: "1.0.0",
    title: "Example Downloads",
    auth: { kind: "none" },
    egress: ["GET files.example.com/attachments", "POST files.example.com/send"],
    operations: {
      download: {
        title: "Download an attachment",
        effect: "read",
        input: { type: "object" },
        output: { type: "object", required: ["file"], properties: { file: fileRef } },
        async handler(_input, ctx) {
          await ctx.blobs.put(bytesOf("scratch"), { mediaType: "text/plain" });
          const file = await ctx.blobs.put(bytesOf("attachment"), { mediaType: "application/pdf" });
          lateBy?.();
          return { file: file as unknown as JsonValue };
        },
      },
      send: {
        title: "Send an attachment, keeping the copy sent",
        effect: "write",
        idempotent: true,
        input: { type: "object" },
        output: { type: "object", required: ["file"], properties: { file: fileRef } },
        async handler(_input, ctx) {
          const file = await ctx.blobs.put(bytesOf("sent"), { mediaType: "application/pdf" });
          lateBy?.();
          return { file: file as unknown as JsonValue };
        },
      },
      echo: {
        title: "Return the file it was given",
        effect: "read",
        input: { type: "object", required: ["file"], properties: { file: fileRef } },
        output: { type: "object", required: ["file"], properties: { file: fileRef } },
        handler: (input) => {
          lateBy?.();
          return { file: input.file! };
        },
      },
    },
  });
  let lateBy: (() => void) | null = null;
  const settle = async (store: MemoryBlobStore, count: number) => {
    for (let i = 0; i < 50 && store.count !== count; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  };

  it("never waits for the deletes of what the answer does not name, so a slow store cannot make it late", async () => {
    lateBy = null;
    const store = memoryBlobStore();
    const slowDelete: BlobStore = { ...store, delete: async (scope, ref, context) => (await new Promise((resolve) => setTimeout(resolve, 300)), store.delete(scope, ref, context)) };
    const deadline = Date.now() + 100;
    const outcome = await invokeOperation(downloads, "download", {}, { fetch: mockFetch(), deadline, idempotencyKey: "k", connection: { id: "c", role: null }, credentials: async () => ({}), scope: TEST_SCOPE, blobs: slowDelete });
    expect(Date.now()).toBeLessThan(deadline);
    expect(outcome).toMatchObject({ status: "ok", output: { file: { mediaType: "application/pdf" } } });
    // The scratch copy goes once its delete finishes; the file the answer names stays.
    await settle(store, 1);
    expect(store.list(TEST_SCOPE)).toEqual([(outcome as unknown as { output: { file: BlobRef } }).output.file]);
  });

  it.each([
    ["a read's answer is retryable", "download", { status: "retryable", error: { code: "connect/timeout" } }],
    ["a write's output is withheld, and the write stays applied", "send", { status: "ok", output: null, withheld: { bytes: expect.any(Number) } }],
  ] as const)("names nothing it stored once the deadline has passed: %s, and every file it stored is deleted", async (_name, operation, expected) => {
    let now = 1_000_000;
    lateBy = () => (now += 10_000);
    const store = memoryBlobStore();
    const logs: string[] = [];
    const outcome = await invokeOperation(downloads, operation, {}, {
      fetch: mockFetch(),
      clock: { now: () => now },
      deadline: now + 5_000,
      idempotencyKey: "k",
      connection: { id: "c", role: null },
      credentials: async () => ({}),
      scope: TEST_SCOPE,
      blobs: store,
      log: (record) => logs.push(`${record.level}:${record.event}`),
    });
    lateBy = null;
    expect(outcome).toMatchObject(expected);
    await settle(store, 0);
    expect(store.count).toBe(0);
    // Not silently: the kit says why the answer named nothing.
    expect(logs).toContain("warn:output.late");
  });

  it("answers a late file the call was given as it is: no run loses it", async () => {
    let now = 1_000_000;
    lateBy = () => (now += 10_000);
    const store = memoryBlobStore();
    const given = await stored(store, "given");
    const outcome = await invokeOperation(downloads, "echo", { file: given as unknown as JsonValue }, { fetch: mockFetch(), clock: { now: () => now }, deadline: now + 5_000, idempotencyKey: "k", connection: { id: "c", role: null }, credentials: async () => ({}), scope: TEST_SCOPE, blobs: store });
    lateBy = null;
    expect(outcome).toEqual({ status: "ok", output: { file: given } });
    expect(store.list(TEST_SCOPE)).toEqual([given]);
  });

  it("gives the deletes to the port's waitUntil, which settles once they are done", async () => {
    lateBy = null;
    const store = memoryBlobStore();
    const slowDelete: BlobStore = { ...store, delete: async (scope, ref, context) => (await new Promise((resolve) => setTimeout(resolve, 50)), store.delete(scope, ref, context)) };
    const pending: Array<Promise<void>> = [];
    const port = createConnectorActionPort({
      audience: CONFORMANCE_AUDIENCE,
      verifier: conformanceVerifier(),
      connectors: [files],
      connections: () => ({ connectionId: "c", grantedScopes: [] }),
      credentials: { headers: () => ({}) },
      fetch: mockFetch(),
      blobs: slowDelete,
      waitUntil: (work) => pending.push(work),
    });
    expect(await port.run(await envelope("example-files.attach", "write", { mode: "throw" }))).toMatchObject({ status: "final", error: { code: "files/refused" } });
    expect(pending).toHaveLength(1);
    expect(store.count).toBe(1);
    await pending[0];
    expect(store.count).toBe(0);
  });
});

const signer = hmacActionSigner(CONFORMANCE_KEY);
let seq = 0;
function envelope(action: string, effect: "read" | "write", input: JsonObject, scope: Scope = CONFORMANCE_SCOPE): Promise<ApprovedAction> {
  return signApprovedAction<ApprovedAction>(
    draftApprovedAction({ action, effect, input, now: Date.now(), audience: CONFORMANCE_AUDIENCE, effectId: `effect-blobs-${++seq}`, scope, ...(effect === "write" ? { idempotent: true } : {}), key: null }),
    signer,
  );
}

describe("the connector action port", () => {
  function port(store: BlobStore) {
    const resolved: Scope[] = [];
    const p = createConnectorActionPort({
      audience: CONFORMANCE_AUDIENCE,
      verifier: conformanceVerifier(),
      connectors: [files],
      connections: (scope) => {
        resolved.push(scope);
        return { connectionId: "c", grantedScopes: [] };
      },
      credentials: { headers: () => ({}) },
      fetch: mockFetch(),
      blobs: store,
    });
    return { port: p, resolved };
  }

  it("stores and reads in the envelope's scope, and checks input references against it", async () => {
    const store = memoryBlobStore();
    const { port: p, resolved } = port(store);
    const put = await p.run(await envelope("example-files.store", "read", { text: "from the port" }));
    expect(put.status).toBe("ok");
    const [ref] = (put as unknown as { output: { files: BlobRef[] } }).output.files;
    expect(store.list(CONFORMANCE_SCOPE)).toEqual([ref]);
    expect(await p.run(await envelope("example-files.read", "read", { file: ref as unknown as JsonValue }))).toEqual({ status: "ok", output: { text: "from the port" } });
    const before = resolved.length;
    const other: Scope = { ...CONFORMANCE_SCOPE, environmentId: "env-other" };
    expect(await p.run(await envelope("example-files.read", "read", { file: ref as unknown as JsonValue }, other))).toMatchObject({ status: "final", error: { code: "connect/invalid-input" } });
    expect(resolved.length).toBe(before);
  });

  it("passes blobPortConformance", async () => {
    const store = memoryBlobStore();
    const { port: p, resolved } = port(store);
    for (const c of blobPortConformance(p, { call: { action: "example-files.read", effect: "read", input: (ref) => ({ file: ref as unknown as JsonValue }) }, performed: () => resolved.length })) await c.run();
  });
});
