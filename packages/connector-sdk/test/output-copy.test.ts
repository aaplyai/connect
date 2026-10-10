/**
 * A handler's returned value is copied once, and every output check reads the
 * copy (ADR-0009, amended by the verification of the 0.2 gaps): a getter that
 * answers the checks one thing and the copy another can no longer hand the
 * engine an `ok` its output schema never saw, nor a copy larger than the one
 * that was measured.
 */

import type { ApprovedAction } from "@aaply/action-contract";
import { CONFORMANCE_AUDIENCE, conformanceVerifier, draftApprovedAction } from "@aaply/action-contract/conformance";
import { describe, expect, it } from "vitest";
import { createConnectorActionPort, defineConnector, memoryReplayGuard } from "../src/index.js";
import { mockFetch } from "../src/testing.js";

const NOW = Date.UTC(2026, 9, 9);
const clock = { now: () => NOW };

function readPort(answer: () => unknown, maxOutputBytes?: number) {
  const mail = defineConnector({
    id: "mail",
    version: "1.0.0",
    title: "Mail",
    auth: { kind: "none" },
    egress: [`GET api.mail.test/v1/*`],
    operations: {
      get: {
        title: "Get",
        effect: "read",
        input: { type: "object" },
        output: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        handler: (async () => answer()) as never,
      },
    },
  });
  return createConnectorActionPort({
    audience: CONFORMANCE_AUDIENCE,
    verifier: conformanceVerifier(),
    replayGuard: memoryReplayGuard(clock),
    connectors: [mail],
    connections: () => ({ connectionId: "c", grantedScopes: [], subjectId: null }),
    credentials: { headers: () => ({}) },
    fetch: mockFetch({}),
    clock,
    observer: { error: () => undefined },
    ...(maxOutputBytes !== undefined ? { maxOutputBytes } : {}),
  });
}

const envelope = (): ApprovedAction => draftApprovedAction({ action: "mail.get", effect: "read", input: {}, now: NOW, role: null, subject: null, idempotent: true });

/** An output whose `id` answers "m-1" to its first `honest` reads and `then` after. */
function shifting(honest: number, then: unknown) {
  let reads = 0;
  return {
    get id() {
      reads += 1;
      return reads <= honest ? "m-1" : then;
    },
  };
}

describe("a handler's output", () => {
  it("is never ok with a value its schema refuses, however often a getter changes its answer", async () => {
    const changed = { not: "a string", big: "y".repeat(5000) };
    const statuses = new Set<string>();
    for (let honest = 0; honest <= 8; honest++) {
      const outcome = await readPort(() => shifting(honest, changed)).run(envelope());
      statuses.add(outcome.status);
      if (outcome.status === "ok") {
        expect(outcome.output, `honest ${honest}`).toEqual({ id: "m-1" });
        expect(Object.getOwnPropertyDescriptor(outcome.output, "id"), `honest ${honest}`).toMatchObject({ value: "m-1" });
      } else {
        expect(outcome, `honest ${honest}`).toMatchObject({ status: "final", error: { code: "connect/bad-output" } });
      }
    }
    // Both ends are met: a getter that changes before the copy is refused, one that changes after it is kept as copied.
    expect(statuses).toEqual(new Set(["ok", "final"]));
  });

  it("is measured as copied: a getter that grows on the copy is held to the size cap", async () => {
    const outcome = await readPort(() => shifting(1, "y".repeat(5000)), 1024).run(envelope());
    expect(outcome).toMatchObject({ status: "final", error: { code: "connect/output-too-large" } });
  });

  it("that cannot be copied, or copies to something that is not JSON, is bad output", async () => {
    const throwing = {
      get id(): string {
        throw new Error("no");
      },
    };
    expect(await readPort(() => throwing).run(envelope())).toMatchObject({ status: "final", error: { code: "connect/bad-output" } });
    expect(await readPort(() => shifting(1, () => "m-1")).run(envelope())).toMatchObject({ status: "final", error: { code: "connect/bad-output" } });
  });
});
