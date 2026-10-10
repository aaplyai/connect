import { DiagnosticsError, type Diagnostic } from "@aaply/action-contract";
import { describe, expect, it } from "vitest";
import {
  defineConnector,
  manifestDigest,
  manifestOf,
  validateConnector,
  validateManifest,
  type ConnectorDefinition,
  type ConnectorManifest,
  type OperationDefinition,
} from "../src/index.js";
import { exampleNotes } from "./fixtures/example-notes.js";

const handler = async () => ({ ok: true });

function readOp(overrides: Partial<OperationDefinition> = {}): OperationDefinition {
  return {
    title: "Read",
    effect: "read",
    input: { type: "object", properties: { id: { type: "string" } } },
    output: { type: "object" },
    handler,
    ...overrides,
  };
}

function writeOp(overrides: Partial<OperationDefinition> = {}): OperationDefinition {
  return { ...readOp(), title: "Write", effect: "write", idempotent: true, ...overrides };
}

function base(overrides: Partial<ConnectorDefinition> = {}): ConnectorDefinition {
  return {
    id: "sample-service",
    version: "1.0.0",
    title: "Sample service",
    auth: { kind: "apiKey" },
    egress: ["GET api.example.com/v1/items/*", "POST api.example.com/v1/items"],
    operations: { get: readOp(), create: writeOp() },
    ...overrides,
  };
}

const codes = (diagnostics: Diagnostic[]) => diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code}@${d.path}`);

describe("validateConnector", () => {
  it("accepts a valid definition", () => {
    expect(validateConnector(base())).toEqual([]);
  });

  it.each<[string, Partial<ConnectorDefinition>, string]>([
    ["uppercase id", { id: "Sample_Service" }, "connector/invalid-id@id"],
    ["trailing dash id", { id: "sample-" }, "connector/invalid-id@id"],
    ["two-part version", { version: "1.0" }, "connector/invalid-version@version"],
    ["leading zero version", { version: "01.0.0" }, "connector/invalid-version@version"],
    ["empty title", { title: " " }, "connector/invalid-field@title"],
    ["unknown auth", { auth: { kind: "basic" } as never }, "connector/invalid-auth@auth.kind"],
    ["duplicate scope", { auth: { kind: "oauth2", scopes: ["a", "a"] } }, "connector/invalid-auth@auth.scopes[1]"],
    ["scope with a space", { auth: { kind: "oauth2", scopes: ["read all"] } }, "connector/invalid-auth@auth.scopes[0]"],
    ["no operations", { operations: {} }, "connector/no-operations@operations"],
  ])("reports %s", (_name, overrides, expected) => {
    expect(codes(validateConnector(base(overrides)))).toContain(expected);
  });

  it("rejects unknown fields at every level", () => {
    const def = { ...base(), extra: 1, operations: { get: { ...readOp(), retries: 3 } } };
    expect(codes(validateConnector(def))).toEqual(expect.arrayContaining(["connector/unknown-field@extra", "connector/unknown-field@operations.get.retries"]));
  });

  it("rejects what is not an object", () => {
    expect(codes(validateConnector(null))).toEqual(["connector/invalid-shape@(root)"]);
    expect(codes(validateConnector([]))).toEqual(["connector/invalid-shape@(root)"]);
  });

  describe("egress rules", () => {
    it.each<[string, string]>([
      ["GET http://api.example.com/x", "connector/egress-not-https"],
      ["GET https://api.example.com/x", "connector/egress-scheme"],
      ["GET ftp://api.example.com/x", "connector/egress-scheme"],
      ["GET 127.0.0.1/x", "connector/egress-ip-literal"],
      ["GET 127.1/x", "connector/egress-ip-literal"],
      ["GET 0x7f000001/x", "connector/egress-ip-literal"],
      ["GET 169.254.169.254/latest/meta-data", "connector/egress-ip-literal"],
      ["GET [::1]/x", "connector/egress-ip-literal"],
      ["GET [fd00:ec2::254]/x", "connector/egress-ip-literal"],
      ["GET localhost/x", "connector/egress-private-host"],
      ["GET api.localhost/x", "connector/egress-private-host"],
      ["GET printer.local/x", "connector/egress-private-host"],
      ["GET metadata.google.internal/x", "connector/egress-private-host"],
      ["GET router.home.arpa/x", "connector/egress-private-host"],
      ["GET 10.0.0.1.nip.io/x", "connector/egress-private-host"],
      ["GET intranet/x", "connector/egress-private-host"],
      ["GET api.example.com:8443/x", "connector/egress-port"],
      ["GET user:secret@api.example.com/x", "connector/egress-credentials"],
      ["GET *.com/x", "connector/egress-wildcard"],
      ["GET api.*.example.com/x", "connector/egress-wildcard"],
      ["GET *example.com/x", "connector/egress-wildcard"],
      ["GET API.example.com/x", "connector/egress-host"],
      ["GET api..example.com/x", "connector/egress-host"],
      ["GET api.example.com./x", "connector/egress-host"],
      ["GET api.example.com/v1/*/items", "connector/egress-path"],
      ["GET api.example.com/v1/../admin", "connector/egress-path"],
      ["GET api.example.com/v1//x", "connector/egress-path"],
      ["GET api.example.com/v1/%2e%2e/admin", "connector/egress-path"],
      ["GET api.example.com/v1/x?debug=1", "connector/egress-path"],
      ["get api.example.com/x", "connector/egress-method"],
      ["CONNECT api.example.com/x", "connector/egress-method"],
      ["GET api.example.com", "connector/egress-format"],
      ["GET  api.example.com/x", "connector/egress-format"],
      ["GET\tapi.example.com/x", "connector/egress-format"],
    ])("refuses %s", (rule, code) => {
      expect(codes(validateConnector(base({ egress: [rule, "POST api.example.com/v1/items"] })))).toContain(`${code}@egress[0]`);
    });

    it.each(["GET api.example.com:443/v1/items/*", "GET *.example.com/v1/*", "GET api.example.com/v1/items", "DELETE files.example-cdn.com/*", "PATCH api.example.com/v1/items/:id"])(
      "accepts %s",
      (rule) => {
        // Several hosts: the definition says which one gets the credential.
        expect(codes(validateConnector(base({ auth: { kind: "apiKey", hosts: ["api.example.com"] }, egress: [rule, "GET api.example.com/v1/items/*", "POST api.example.com/v1/items"] })))).toEqual([]);
      },
    );

    it("requires an operation's egress to stay inside the connector's", () => {
      const def = base({
        operations: {
          get: readOp({ egress: ["GET api.example.com/v1/items/42", "GET api.example.com/v1/other"] }),
          create: writeOp({ egress: ["POST api.example.com/v1/items"] }),
        },
      });
      expect(codes(validateConnector(def))).toEqual(["connector/egress-not-declared@operations.get.egress[1]"]);
    });

    it("lets wildcard rules cover narrower hosts and prefixes cover narrower paths", () => {
      const def = base({
        auth: { kind: "apiKey", hosts: ["api.example.com"] },
        egress: ["GET *.example.com/v1/*", "POST api.example.com/v1/items"],
        operations: { get: readOp({ egress: ["GET eu.api.example.com/v1/items/*", "GET *.files.example.com/v1/x"] }), create: writeOp() },
      });
      expect(codes(validateConnector(def))).toEqual([]);
      const tooWide = base({ auth: { kind: "apiKey", hosts: ["api.example.com"] }, egress: ["GET *.example.com/v1/*", "POST api.example.com/v1/items"], operations: { get: readOp({ egress: ["GET example.com/v1/x"] }), create: writeOp() } });
      expect(codes(validateConnector(tooWide))).toEqual(["connector/egress-not-declared@operations.get.egress[0]"]);
    });

    it("warns about duplicate rules", () => {
      const diagnostics = validateConnector(base({ egress: ["GET api.example.com/v1/items/*", "GET api.example.com/v1/items/*", "POST api.example.com/v1/items"] }));
      expect(diagnostics).toEqual([expect.objectContaining({ code: "connector/egress-duplicate", severity: "warning", path: "egress[1]" })]);
    });
  });

  describe("operations", () => {
    it.each<[string, Record<string, OperationDefinition>, string]>([
      ["capitalised name", { Get: readOp(), create: writeOp() }, "connector/invalid-operation-name@operations.Get"],
      ["kebab name", { "get-item": readOp(), create: writeOp() }, 'connector/invalid-operation-name@operations["get-item"]'],
      ["unknown effect", { get: readOp({ effect: "delete" as never }), create: writeOp() }, "connector/invalid-effect@operations.get.effect"],
      ["missing input schema", { get: readOp({ input: undefined as never }), create: writeOp() }, "connector/missing-schema@operations.get.input"],
      ["missing output schema", { get: readOp({ output: undefined as never }), create: writeOp() }, "connector/missing-schema@operations.get.output"],
      ["non-object input", { get: readOp({ input: { type: "string" } }), create: writeOp() }, "connector/input-not-object@operations.get.input.type"],
      ["unknown schema keyword", { get: readOp({ output: { type: "object", oneOf: [] } as never }), create: writeOp() }, "connector/invalid-schema@operations.get.output.oneOf"],
      ["unsafe pattern", { get: readOp({ output: { type: "string", pattern: "(?=a)a" } }), create: writeOp() }, "connector/invalid-schema@operations.get.output.pattern"],
      ["missing handler", { get: readOp({ handler: undefined as never }), create: writeOp() }, "connector/missing-handler@operations.get.handler"],
      ["bad risk floor", { get: readOp(), create: writeOp({ riskFloor: "high" as never }) }, "connector/invalid-field@operations.create.riskFloor"],
      ["non-boolean flag", { get: readOp(), create: writeOp({ idempotent: "yes" as never }) }, "connector/invalid-field@operations.create.idempotent"],
      ["write without undo", { get: readOp(), create: writeOp({ idempotent: false }) }, "connector/write-needs-undo@operations.create"],
      ["compensable and irreversible", { get: readOp(), create: writeOp({ compensate: "remove", irreversible: true }), remove: writeOp() }, "connector/write-undo-conflict@operations.create"],
      ["compensate names nothing", { get: readOp(), create: writeOp({ compensate: "remove" }) }, "connector/compensate-unknown@operations.create.compensate"],
      ["compensate names a read", { get: readOp(), create: writeOp({ compensate: "get" }) }, "connector/compensate-not-write@operations.create.compensate"],
      ["compensate names itself", { get: readOp(), create: writeOp({ compensate: "create" }) }, "connector/compensate-self@operations.create.compensate"],
      ["read with compensate", { get: readOp({ compensate: "create" }), create: writeOp() }, "connector/read-with-write-option@operations.get.compensate"],
      ["irreversible read", { get: readOp({ irreversible: true }), create: writeOp() }, "connector/read-with-write-option@operations.get.irreversible"],
      ["read with a risk floor", { get: readOp({ riskFloor: "confirm" }), create: writeOp() }, "connector/read-with-write-option@operations.get.riskFloor"],
      ["write that may only GET", { get: readOp(), create: writeOp({ egress: ["GET api.example.com/v1/items/*"] }) }, "connector/write-without-unsafe-egress@operations.create"],
    ])("reports %s", (_name, operations, expected) => {
      expect(codes(validateConnector(base({ operations })))).toContain(expected);
    });

    it("accepts dotted names and a read with riskFloor none", () => {
      expect(codes(validateConnector(base({ operations: { "items.get": readOp({ riskFloor: "none" }), create: writeOp() } })))).toEqual([]);
    });

    it("warns when an undo operation is not idempotent", () => {
      const diagnostics = validateConnector(base({ operations: { get: readOp(), create: writeOp({ compensate: "remove" }), remove: writeOp({ idempotent: false, irreversible: true }) } }));
      expect(diagnostics).toEqual([expect.objectContaining({ code: "connector/compensate-not-idempotent", severity: "warning", path: "operations.create.compensate" })]);
    });

    it("warns when an undo operation needs a review, which nobody gives an undo", () => {
      const diagnostics = validateConnector(base({ operations: { get: readOp(), create: writeOp({ compensate: "remove" }), remove: writeOp({ idempotent: true, riskFloor: "approval" }) } }));
      expect(diagnostics).toEqual([expect.objectContaining({ code: "connector/compensate-reviewed", severity: "warning", path: "operations.create.compensate" })]);
    });
  });
});

describe("defineConnector", () => {
  it("throws diagnostics for an invalid definition", () => {
    let caught: unknown;
    try {
      defineConnector(base({ id: "Bad Id", egress: ["GET 10.0.0.1/x"] }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DiagnosticsError);
    expect(codes([...(caught as DiagnosticsError).diagnostics])).toEqual(expect.arrayContaining(["connector/invalid-id@id", "connector/egress-ip-literal@egress[0]"]));
  });

  it("returns a frozen connector with defaults filled in", () => {
    const connector = defineConnector(base());
    expect(Object.isFrozen(connector)).toBe(true);
    expect(Object.isFrozen(connector.operations)).toBe(true);
    expect(Object.isFrozen(connector.operations.get!.input)).toBe(true);
    expect(Object.isFrozen(connector.operations.get!.input.properties!.id)).toBe(true);
    expect(connector.operations.get).toMatchObject({ idempotent: false, irreversible: false, riskFloor: "none", egress: base().egress });
    expect(() => {
      (connector.operations.get!.input as { type: string }).type = "string";
    }).toThrow(TypeError);
  });

  it("does not share state with the definition it was built from", () => {
    const def = base();
    const connector = defineConnector(def);
    (def.operations.get!.input.properties as Record<string, unknown>).extra = { type: "string" };
    (def.egress as string[]).push("GET evil.example.org/*");
    expect(connector.operations.get!.input.properties).not.toHaveProperty("extra");
    expect(connector.egress).not.toContain("GET evil.example.org/*");
  });
});

describe("manifests", () => {
  it("describes everything except the handlers, as plain JSON", () => {
    const manifest = manifestOf(exampleNotes);
    expect(JSON.parse(JSON.stringify(manifest))).toEqual(manifest);
    expect(JSON.stringify(manifest)).not.toContain("handler");
    expect(manifest).toMatchObject({
      manifestVersion: 1,
      id: "example-notes",
      version: "1.0.0",
      auth: { kind: "oauth2", scopes: ["notes.read", "notes.write"] },
      operations: {
        create: { effect: "write", idempotent: true, compensate: "delete", irreversible: false, riskFloor: "none", egress: ["POST api.example.com/v1/notes"] },
        get: { effect: "read", idempotent: false, irreversible: false, riskFloor: "none" },
      },
    });
    expect(validateManifest(manifest)).toEqual([]);
  });

  it("has a digest that depends on content, not key order", () => {
    const manifest = manifestOf(exampleNotes);
    const digest = manifestDigest(manifest);
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    const reordered = Object.fromEntries(Object.entries(manifest).reverse()) as unknown as ConnectorManifest;
    expect(manifestDigest(reordered)).toBe(digest);
    expect(manifestDigest({ ...manifest, version: "1.0.1" })).not.toBe(digest);
    const widened = { ...manifest, egress: [...manifest.egress, "GET api.example.com/v2/*"] };
    expect(manifestDigest(widened)).not.toBe(digest);
  });

  it("refuses manifests with code, unknown fields or a wrong version", () => {
    const manifest = manifestOf(exampleNotes);
    const withCode = { ...manifest, operations: { ...manifest.operations, get: { ...manifest.operations.get!, handler } } };
    expect(codes(validateManifest(withCode))[0]).toMatch(/^connector\/invalid-shape/);
    expect(codes(validateManifest({ ...manifest, manifestVersion: 2 }))).toEqual(["connector/invalid-field@manifestVersion"]);
    expect(codes(validateManifest({ ...manifest, operations: { ...manifest.operations, get: { ...manifest.operations.get!, handler: "x" } } }))).toEqual([
      "connector/unknown-field@operations.get.handler",
    ]);
  });

  it("re-validates connectors that did not come from defineConnector", () => {
    const forged = { ...exampleNotes, egress: ["GET 127.0.0.1/*"] };
    expect(() => manifestOf(forged)).toThrow(/egress-ip-literal/);
  });
});
