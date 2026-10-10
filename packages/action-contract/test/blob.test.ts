import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BLOB_REF_SCHEMA, DiagnosticBag, MAX_BLOB_NAME_LENGTH, assignabilityProblems, blobBinding, blobConstraintCovers, blobDigest, blobDigestSync, checkBlobRef, checkSchema, copyBlobRef, findBlobRefs, hasBlobRefs, isBlobRef, isBlobRefLike, isMediaTypePattern, makeBlobRef, mapBlobRefs, mediaTypeMatches, normalizeMediaType, operationDigest, schemaUsesBlob, refuse, sanitizeBlobName, validateValue, verifyApprovedAction, type ActionOutcome, type ActionPort, type BlobRef, type JsonSchema, type JsonValue, type Scope } from "@aaply/action-contract";
import { CONFORMANCE_SCOPE, blobPortConformance, conformanceVerifier, CONFORMANCE_AUDIENCE } from "../src/api/conformance.js";

const SCOPE: Scope = { tenantId: "t-1", appId: "a-1", environmentId: "e-1" };
const bytes = new TextEncoder().encode("%PDF-1.7 hello");
const parts = { id: "blob-1", digest: blobDigestSync(bytes), size: bytes.length, mediaType: "application/pdf", name: "invoice.pdf" };
const ref = makeBlobRef(SCOPE, parts);

describe("blob references", () => {
  it("are bound to the scope they were made in, and to nothing else", () => {
    expect(checkBlobRef(ref, SCOPE)).toBeNull();
    expect(isBlobRef(ref, SCOPE)).toBe(true);
    for (const other of [{ ...SCOPE, tenantId: "t-2" }, { ...SCOPE, appId: "a-2" }, { ...SCOPE, environmentId: "e-2" }]) {
      expect(checkBlobRef(ref, other)).toMatchObject({ code: "foreign" });
    }
    // Without a scope only the shape is checked.
    expect(checkBlobRef(ref)).toBeNull();
  });

  it("bind every field but the name, so a changed media type, size or digest no longer matches", () => {
    expect(checkBlobRef({ ...ref, mediaType: "application/x-msdownload" }, SCOPE)).toMatchObject({ code: "foreign" });
    expect(checkBlobRef({ ...ref, size: ref.size + 1 }, SCOPE)).toMatchObject({ code: "foreign" });
    expect(checkBlobRef({ ...ref, digest: blobDigestSync(new Uint8Array([1])) }, SCOPE)).toMatchObject({ code: "foreign" });
    expect(checkBlobRef({ ...ref, id: "blob-2" }, SCOPE)).toMatchObject({ code: "foreign" });
    expect(checkBlobRef({ ...ref, name: "renamed.pdf" }, SCOPE)).toBeNull();
    const { name: _name, ...nameless } = ref;
    expect(checkBlobRef(nameless, SCOPE)).toBeNull();
  });

  it("compute the binding from a fixed tag and the canonical scope and fields, so any side can check it", () => {
    const body = JSON.stringify({ digest: parts.digest, id: "blob-1", mediaType: "application/pdf", scope: { appId: "a-1", environmentId: "e-1", tenantId: "t-1" }, size: parts.size });
    expect(ref.binding).toBe(`sha256:${createHash("sha256").update(`aaply.blob-ref.1\n${body}`).digest("hex")}`);
    expect(blobBinding(SCOPE, ref)).toBe(ref.binding);
  });

  it("have exactly their fields, each well-formed", () => {
    const bad: Array<[string, unknown]> = [
      ["not an object", "blob-1"],
      ["an array", [ref]],
      ["an extra field", { ...ref, url: "https://x.example.com/" }],
      ["another version", { ...ref, $blob: 2 }],
      ["no marker", { ...ref, $blob: undefined }],
      ["an empty id", { ...ref, id: "" }],
      ["an id with a space", { ...ref, id: "a b" }],
      ["a long id", { ...ref, id: "x".repeat(257) }],
      ["an upper-case digest", { ...ref, digest: ref.digest.toUpperCase() }],
      ["a negative size", { ...ref, size: -1 }],
      ["a fractional size", { ...ref, size: 1.5 }],
      ["an unsafe size", { ...ref, size: 2 ** 60 }],
      ["an upper-case media type", { ...ref, mediaType: "Application/PDF" }],
      ["a media type with parameters", { ...ref, mediaType: "text/plain; charset=utf-8" }],
      ["a name with a separator", { ...ref, name: "../etc/passwd" }],
      ["a name with a control character", { ...ref, name: "a\u0000b" }],
      ["a name with a bidirectional override", { ...ref, name: "invoice‮fdp.exe" }],
      ["a name with surrounding spaces", { ...ref, name: " a.pdf" }],
      ["a dot name", { ...ref, name: ".." }],
      ["a long name", { ...ref, name: "x".repeat(MAX_BLOB_NAME_LENGTH + 1) }],
      ["a malformed binding", { ...ref, binding: "sha256:nope" }],
    ];
    for (const [what, value] of bad) {
      const clean = JSON.parse(JSON.stringify(value ?? null)) as unknown;
      expect(checkBlobRef(clean, SCOPE), what).toMatchObject({ code: "malformed" });
    }
    expect(checkBlobRef({ ...ref, name: "x".repeat(MAX_BLOB_NAME_LENGTH) }, SCOPE)).toBeNull();
  });

  it("are read without throwing, whatever they hold", () => {
    const hostile = { $blob: 1, get id(): string { throw new Error("boom"); } };
    expect(checkBlobRef(hostile)).toMatchObject({ code: "malformed" });
    expect(findBlobRefs({ a: hostile })).toHaveLength(1);
  });

  it("normalise media types and names the way a store needs", () => {
    expect(normalizeMediaType("Application/PDF; q=1")).toBe("application/pdf");
    expect(normalizeMediaType("image/svg+xml")).toBe("image/svg+xml");
    for (const v of ["pdf", "/pdf", "application/", "a/b/c", "", 7, "text/pl ain"]) expect(normalizeMediaType(v)).toBeNull();
    expect(isMediaTypePattern("image/*")).toBe(true);
    expect(isMediaTypePattern("*/*")).toBe(false);
    expect(isMediaTypePattern("Image/png")).toBe(false);
    expect(mediaTypeMatches("image/*", "image/png")).toBe(true);
    expect(mediaTypeMatches("image/*", "imagex/png")).toBe(false);
    expect(mediaTypeMatches("application/pdf", "application/pdfx")).toBe(false);
    expect(sanitizeBlobName("../../etc/passwd")).toBe(".._.._etc_passwd");
    expect(sanitizeBlobName("invoice‮fdp.exe")).toBe("invoicefdp.exe");
    expect(sanitizeBlobName("  report\u0007.pdf  ")).toBe("report.pdf");
    expect(sanitizeBlobName("x".repeat(400))).toHaveLength(MAX_BLOB_NAME_LENGTH);
    for (const v of ["", "   ", ".", "..", "\u0000", 7]) expect(sanitizeBlobName(v)).toBeNull();
    expect(makeBlobRef(SCOPE, { ...parts, mediaType: "Application/PDF", name: "a/b.pdf" })).toMatchObject({ mediaType: "application/pdf", name: "a_b.pdf" });
    expect(() => makeBlobRef(SCOPE, { ...parts, mediaType: "pdf" })).toThrow(TypeError);
    expect(() => makeBlobRef(SCOPE, { ...parts, id: "has space" })).toThrow(TypeError);
  });

  it("digest the bytes with SHA-256, with or without WebCrypto", async () => {
    const abc = new TextEncoder().encode("abc");
    const expected = "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    expect(blobDigestSync(abc)).toBe(expected);
    expect(await blobDigest(abc)).toBe(expected);
  });

  it("are found by their marker, without looking inside one, and replaced without changing the original", () => {
    const value = { a: [1, { file: ref }], b: { nested: { deeper: ref } }, c: "x", d: { $blob: 1, inside: { $blob: 1 } } };
    const found = findBlobRefs(value);
    expect(found.map((f) => f.path)).toEqual([["a", 1, "file"], ["b", "nested", "deeper"], ["d"]]);
    expect(findBlobRefs(value, { limit: 1 })).toHaveLength(2);
    expect(hasBlobRefs(value)).toBe(true);
    expect(hasBlobRefs({ a: [1, "$blob"], b: { blob: 1 } })).toBe(false);
    expect(isBlobRefLike(ref)).toBe(true);
    expect(isBlobRefLike([ref])).toBe(false);
    const before = JSON.stringify(value);
    const mapped = mapBlobRefs(value, (r) => ({ ...r, url: null }));
    expect(JSON.stringify(value)).toBe(before);
    expect(mapped.a[1]).toEqual({ file: { ...ref, url: null } });
    expect(mapped.c).toBe("x");
    // Unchanged parts are shared, not copied.
    const plain = { x: { y: [1, 2] } };
    expect(mapBlobRefs(plain, () => null)).toBe(plain);
    expect(copyBlobRef({ ...ref })).toEqual(ref);
  });
});

describe("the blob schema keyword", () => {
  const check = (schema: unknown) => {
    const bag = new DiagnosticBag();
    checkSchema(schema, [], bag);
    return bag.items.map((d) => `${d.code} ${d.path}`);
  };

  it("accepts true or media types and a size, beside annotations only", () => {
    expect(check({ blob: true })).toEqual([]);
    expect(check({ blob: { mediaTypes: ["image/*", "application/pdf"], maxBytes: 1024 }, title: "Receipt", "x-ui": "upload" })).toEqual([]);
    expect(check({ type: "object", properties: { file: { blob: true } }, required: ["file"] })).toEqual([]);
    expect(check({ type: "array", items: { blob: { mediaTypes: ["image/png"] } } })).toEqual([]);
    expect(check({ anyOf: [{ blob: true }, { type: "null" }] })).toEqual([]);
  });

  it("refuses a malformed constraint, and anything beside it, once each", () => {
    for (const blob of [false, null, "pdf", {}, { mediaTypes: [] }, { mediaTypes: ["PDF"] }, { mediaTypes: ["*/*"] }, { mediaTypes: ["image/png", "image/png"] }, { maxBytes: 0 }, { maxBytes: 1.5 }, { other: 1 }]) {
      const items = check({ blob });
      if (Object.keys(blob ?? {}).length === 0 && blob !== null && typeof blob === "object") {
        // {} is `true` without the shorthand: no options, any file.
        expect(items, JSON.stringify(blob)).toEqual([]);
      } else {
        expect(items, JSON.stringify(blob)).toEqual(["flow/schema-invalid blob"]);
      }
    }
    expect(check({ blob: true, type: "object" })).toEqual(["flow/schema-invalid type"]);
    expect(check({ blob: true, properties: {} })).toEqual(["flow/schema-invalid properties"]);
  });

  it("validates a reference's shape, media type and size, but not its scope", () => {
    const schema: JsonSchema = { blob: { mediaTypes: ["application/*"], maxBytes: 100 } };
    expect(validateValue(schema, ref as unknown as JsonValue)).toEqual([]);
    expect(validateValue({ blob: true }, makeBlobRef({ ...SCOPE, tenantId: "t-9" }, parts) as unknown as JsonValue)).toEqual([]);
    expect(validateValue(schema, { ...ref, mediaType: "image/png" } as unknown as JsonValue)[0]).toMatchObject({ code: "blob", message: "files of type image/png are not accepted" });
    expect(validateValue({ blob: { maxBytes: 3 } }, ref as unknown as JsonValue)[0]).toMatchObject({ code: "blob" });
    expect(validateValue({ blob: true }, "https://files.example.com/a.pdf")[0]).toMatchObject({ code: "blob" });
    expect(validateValue({ blob: true }, { ...ref, url: "https://x" } as unknown as JsonValue)[0]).toMatchObject({ code: "blob" });
    const nested: JsonSchema = { type: "object", properties: { files: { type: "array", items: { blob: true } } } };
    expect(validateValue(nested, { files: [ref as unknown as JsonValue, "nope"] })).toEqual([expect.objectContaining({ path: ["files", 1], code: "blob" })]);
  });

  it("is assignable to a blob schema that covers it, and reads as the reference's shape elsewhere", () => {
    const pdf: JsonSchema = { blob: { mediaTypes: ["application/pdf"], maxBytes: 100 } };
    expect(assignabilityProblems(pdf, { blob: true })).toEqual([]);
    expect(assignabilityProblems(pdf, { blob: { mediaTypes: ["application/*"], maxBytes: 1000 } })).toEqual([]);
    expect(assignabilityProblems({ blob: true }, pdf)[0]).toMatchObject({ code: "blob" });
    expect(assignabilityProblems({ blob: { mediaTypes: ["image/*"] } }, { blob: { mediaTypes: ["image/png"] } })[0]).toMatchObject({ code: "blob" });
    expect(assignabilityProblems(pdf, { blob: { mediaTypes: ["application/pdf"], maxBytes: 10 } })[0]).toMatchObject({ code: "blob" });
    expect(assignabilityProblems({ type: "object" }, pdf)[0]).toMatchObject({ code: "blob" });
    // An untyped side may hold a reference (a narrowing, "blob"); one that never sends an object cannot (a type error).
    expect(assignabilityProblems({}, pdf)).toEqual([expect.objectContaining({ code: "blob" })]);
    expect(assignabilityProblems({ type: ["string", "null"] }, pdf)).toEqual([expect.objectContaining({ code: "type", message: "sends string or null; receiving side expects a file reference" })]);
    expect(assignabilityProblems({ enum: ["a", 1] }, pdf)).toEqual([expect.objectContaining({ code: "type" })]);
    // A section that reads the name and an optional URL accepts it; one that requires the URL may get none.
    expect(assignabilityProblems(pdf, { type: "object", properties: { name: { type: "string" }, url: { type: ["string", "null"] } } })).toEqual([]);
    expect(assignabilityProblems(pdf, { type: "object", required: ["url"], properties: { url: { type: "string" } } }).map((p) => p.code)).toContain("required");
    expect(assignabilityProblems(pdf, { type: "string" })[0]).toMatchObject({ code: "type" });
    expect(BLOB_REF_SCHEMA.required).toEqual(["$blob", "id", "digest", "size", "mediaType", "binding"]);
    expect(validateValue(BLOB_REF_SCHEMA, { ...ref, url: null } as unknown as JsonValue)).toEqual([]);
  });

  it("leaves an operation contract's digest as it was when no schema uses it", () => {
    // Computed at 8e8466f, before the keyword existed.
    expect(
      operationDigest({
        effect: "write",
        idempotent: true,
        irreversible: false,
        compensate: "files.delete",
        riskFloor: "confirm",
        input: { type: "object", required: ["path"], properties: { path: { type: "string", maxLength: 200 } } },
        output: { type: "object", properties: { id: { type: "string" } } },
      }),
    ).toBe("sha256:1576ea4db7a82d9ebe5babdb4b50331195dee4124ae557e3a59dbf8422b608c9");
  });

  it("covers media types by type wildcard and size", () => {
    expect(blobConstraintCovers({ mediaTypes: ["image/png", "image/*"] }, { mediaTypes: ["image/*"] })).toBeNull();
    expect(blobConstraintCovers(true, { maxBytes: 5 })).toMatch(/at most 5 bytes/);
    expect(blobConstraintCovers({ maxBytes: 5 }, true)).toBeNull();
  });

  it("is found wherever a schema can sit, and not in data or property names", () => {
    expect(schemaUsesBlob({ blob: true })).toBe(true);
    expect(schemaUsesBlob({ type: "object", properties: { a: { type: "array", items: { anyOf: [{ type: "null" }, { blob: { maxBytes: 1 } }] } } } })).toBe(true);
    expect(schemaUsesBlob({ type: "object", additionalProperties: { blob: true } })).toBe(true);
    expect(schemaUsesBlob({ type: "object", properties: { blob: { type: "string" } } })).toBe(false);
    expect(schemaUsesBlob({ const: { blob: true }, enum: [{ blob: true }], default: { blob: true }, examples: [{ blob: true }] })).toBe(false);
    expect(schemaUsesBlob({ type: "object", additionalProperties: false })).toBe(false);
    expect(schemaUsesBlob(null)).toBe(false);
    const hostile = { get properties(): never { throw new Error("no"); } };
    expect(schemaUsesBlob(hostile)).toBe(false);
  });
});

describe("blobPortConformance", () => {
  /** A port that checks the envelope and the input's references, as every performer must. */
  const checkingPort = (counter: { n: number }, checkRefs: boolean): ActionPort => ({
    async run(approved): Promise<ActionOutcome> {
      const checked = await verifyApprovedAction(approved, { now: Date.now(), audience: CONFORMANCE_AUDIENCE, verifier: conformanceVerifier() });
      if (!checked.ok) return checked.outcome;
      if (checkRefs) {
        for (const found of findBlobRefs(checked.action.input)) {
          const problem = checkBlobRef(found.value, checked.action.scope);
          if (problem) return refuse("connect/invalid-input", "A file reference in the input cannot be used.", { detail: problem.message });
        }
      }
      counter.n++;
      return { status: "ok", output: null };
    },
  });
  const call = { action: "files.read", effect: "read" as const, input: (r: BlobRef) => ({ file: r as unknown as JsonValue }) };

  it("passes a port that checks references against the envelope's scope", async () => {
    const counter = { n: 0 };
    const cases = blobPortConformance(checkingPort(counter, true), { call, performed: () => counter.n });
    expect(cases.length).toBeGreaterThanOrEqual(3);
    for (const c of cases) await c.run();
    expect(counter.n).toBe(0);
  });

  it("fails a port that performs a call with another scope's reference", async () => {
    const counter = { n: 0 };
    const cases = blobPortConformance(checkingPort(counter, false), { call, performed: () => counter.n });
    const results = await Promise.allSettled(cases.map((c) => c.run()));
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect(String((results[0] as PromiseRejectedResult).reason)).toMatch(/another tenant's reference/);
  });

  it("uses the contract's conformance scope by default", () => {
    expect(CONFORMANCE_SCOPE.tenantId).toBe("tenant-conformance");
  });
});
