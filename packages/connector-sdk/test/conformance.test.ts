import { describe, expect, it } from "vitest";
import { defineConnector, type Connector } from "../src/index.js";
import { connectorConformanceCases, type ConformanceSample } from "../src/testing.js";
import { NOTES_API, exampleNotes } from "./fixtures/example-notes.js";
import { notesBackend } from "./fixtures/notes-backend.js";

function samples(): Record<string, ConformanceSample> {
  const backend = notesBackend();
  const seeded = backend.seed("Seeded note", "Body");
  return {
    list: { input: { limit: 10 }, routes: backend.routes },
    get: { input: { id: seeded.id }, routes: backend.routes, invalidInput: { id: "../etc" } },
    create: { input: { title: "Conformance", body: "Check" }, routes: backend.routes },
    delete: { input: { id: seeded.id }, routes: backend.routes },
  };
}

describe("example-notes conformance", () => {
  for (const c of connectorConformanceCases(exampleNotes, samples())) it(c.name, c.run);
});

describe("a connector with a write that does not de-duplicate", () => {
  // The suite's port needs a replay guard for it, or it could not be created.
  const once = defineConnector({ ...exampleNotes, id: "notes-once", operations: { ...exampleNotes.operations, create: { ...exampleNotes.operations.create!, idempotent: false } } });
  it("passes the suite", async () => {
    expect(await failures(once, samples())).toEqual([]);
  });
});

async function failures(connector: Connector, sampleSet: Record<string, ConformanceSample>): Promise<string[]> {
  const out: string[] = [];
  for (const c of connectorConformanceCases(connector, sampleSet)) {
    try {
      await c.run();
    } catch (error) {
      out.push(`${c.name} :: ${(error as Error).message}`);
    }
  }
  return out;
}

describe("conformance catches broken connectors", () => {
  it("a handler that bypasses ctx.http", async () => {
    const leaky = defineConnector({
      ...exampleNotes,
      operations: {
        ...exampleNotes.operations,
        list: {
          ...exampleNotes.operations.list!,
          async handler() {
            await globalThis.fetch(`${NOTES_API}?leak=1`).catch(() => undefined);
            return { notes: [], nextCursor: null };
          },
        },
      },
    });
    const found = await failures(leaky, samples());
    expect(found).toEqual(expect.arrayContaining([expect.stringMatching(/list: the sample succeeds .*global fetch/)]));
    expect(found.length).toBeGreaterThan(0);
    for (const failure of found) expect(failure).toMatch(/^example-notes: list: .*global fetch/);
  });

  it("an idempotent create that does not send the key", async () => {
    const keyless = defineConnector({
      ...exampleNotes,
      operations: {
        ...exampleNotes.operations,
        create: {
          ...exampleNotes.operations.create!,
          async handler(input, ctx) {
            const res = await ctx.http({ method: "POST", url: NOTES_API, json: { title: input.title as string } });
            const raw = res.ensureOk().json() as Record<string, string>;
            return { id: raw.id!, title: raw.title!, body: raw.body!, createdAt: raw.created_at!, updatedAt: raw.updated_at! };
          },
        },
      },
    });
    const found = await failures(keyless, samples());
    expect(found).toEqual([expect.stringMatching(/create: the idempotency key .*does not carry ctx.idempotencyKey/)]);
  });

  it("a constant key instead of ctx.idempotencyKey", async () => {
    const constant = defineConnector({
      ...exampleNotes,
      operations: {
        ...exampleNotes.operations,
        create: {
          ...exampleNotes.operations.create!,
          async handler(input, ctx) {
            const res = await ctx.http({ method: "POST", url: NOTES_API, headers: { "idempotency-key": "idem-conformance-AAAAAAAAAAAA" }, json: { title: input.title as string } });
            const raw = res.ensureOk().json() as Record<string, string>;
            return { id: raw.id!, title: raw.title!, body: raw.body!, createdAt: raw.created_at!, updatedAt: raw.updated_at! };
          },
        },
      },
    });
    const found = await failures(constant, samples());
    expect(found).toEqual([expect.stringMatching(/create: the idempotency key .*another effect/)]);
  });

  it("an output that does not match the schema, a missing sample and a non-idempotent undo", async () => {
    const sloppy = defineConnector({
      ...exampleNotes,
      operations: {
        ...exampleNotes.operations,
        get: { ...exampleNotes.operations.get!, handler: async () => ({ id: "n-1", title: "No dates" }) },
        delete: { ...exampleNotes.operations.delete!, idempotent: false, irreversible: true },
      },
    });
    const { list: _list, ...rest } = samples();
    const found = await failures(sloppy, rest);
    expect(found).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/every operation has a valid sample :: .*no sample for operation "list"/),
        expect.stringMatching(/writes declare undo semantics :: .*"delete" undoes "create" but is not idempotent/),
        expect.stringMatching(/get: the sample succeeds .*connect\/bad-output/),
      ]),
    );
  });

  it("a sample whose invalid input is actually valid", async () => {
    const set = samples();
    set.get = { ...set.get!, invalidInput: { id: "fine" } };
    expect(await failures(exampleNotes, set)).toEqual([expect.stringMatching(/get: invalid input is refused .*is valid under its input schema/)]);
  });
});
