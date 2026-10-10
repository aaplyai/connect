/**
 * An operation whose behaviour is declared data (a SQL statement the host
 * interprets) carries that data's digest as `implementation`, so a flow's
 * pin covers the exact statement.
 */
import { operationDigest, sha256Digest, type JsonObject } from "@aaply/action-contract";
import { CONFORMANCE_AUDIENCE, conformanceVerifier, draftApprovedAction } from "@aaply/action-contract/conformance";
import { describe, expect, it } from "vitest";
import { createConnectorActionPort, defineConnector, manifestOf, operationContractOf, validateConnector, validateManifest, type ConnectorDefinition } from "../src/index.js";

const NOW = Date.UTC(2026, 9, 10);

function declared(statement: string | null, implementation?: unknown): ConnectorDefinition {
  return {
    id: "booking-db",
    version: "1.0.0",
    title: "Booking database",
    auth: { kind: "none" },
    egress: [],
    operations: {
      find: {
        title: "Find a slot",
        effect: "read",
        input: { type: "object" },
        output: { type: "object" },
        ...(statement !== null ? { implementation: (implementation ?? sha256Digest({ statement })) as never } : {}),
        handler: async () => ({ found: true }),
      },
    },
  };
}

describe("a declared implementation", () => {
  it("is carried in the manifest and the operation contract only when declared, and changes the pin", () => {
    const code = defineConnector(declared(null));
    const a = defineConnector(declared("select 1"));
    const b = defineConnector(declared("select 2"));
    expect(operationContractOf(code, "find")).not.toHaveProperty("implementation");
    expect(manifestOf(code).operations.find).not.toHaveProperty("implementation");
    expect(operationContractOf(a, "find")!.implementation).toBe(sha256Digest({ statement: "select 1" }));
    expect(manifestOf(a).operations.find!.implementation).toBe(sha256Digest({ statement: "select 1" }));
    expect(validateManifest(manifestOf(a))).toEqual([]);
    const pins = [code, a, b].map((c) => operationDigest(operationContractOf(c, "find")!));
    expect(new Set(pins).size).toBe(3);
  });

  it("lets a write that runs declared data have no HTTP write egress", () => {
    const write = (implementation?: string): ConnectorDefinition => ({
      ...declared(null),
      operations: {
        put: {
          title: "Put",
          effect: "write",
          idempotent: true,
          input: { type: "object" },
          output: { type: "object" },
          ...(implementation ? { implementation: implementation as never } : {}),
          handler: async () => ({}),
        },
      },
    });
    expect(validateConnector(write(sha256Digest({ statement: "insert into t default values" })))).toEqual([]);
    expect(validateConnector(write()).map((d) => d.code)).toEqual(["connector/write-without-unsafe-egress"]);
  });

  it("is refused when it is not a sha256 digest", () => {
    for (const bad of ["sha256:xyz", "md5:00", 42]) {
      expect(validateConnector(declared("select 1", bad)).map((d) => `${d.code}@${d.path}`)).toEqual(["connector/invalid-field@operations.find.implementation"]);
    }
  });

  it("is checked against the flow's pin before the operation runs", async () => {
    const a = defineConnector(declared("select 1"));
    const port = createConnectorActionPort({
      audience: CONFORMANCE_AUDIENCE,
      verifier: conformanceVerifier(),
      connectors: [a],
      connections: () => ({ connectionId: "db", grantedScopes: [], subjectId: null }),
      credentials: { headers: () => ({}) },
      clock: { now: () => NOW },
    });
    const send = (contract: string) => port.run(draftApprovedAction({ action: "booking-db.find", effect: "read", input: {} as JsonObject, now: NOW, contract: contract as never }));
    expect(await send(operationDigest(operationContractOf(a, "find")!))).toEqual({ status: "ok", output: { found: true } });
    const stale = operationDigest(operationContractOf(defineConnector(declared("select 2")), "find")!);
    expect(await send(stale)).toMatchObject({ status: "final", error: { code: "connect/contract-mismatch" } });
  });
});
