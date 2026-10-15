/**
 * Notion's undo is undo-only: a flow names it only as the create's
 * compensate, and every field of that compensate reads the create's output.
 * That binds the undo to the page the create made only if the output holds
 * nothing the flow chose. A create that echoed its parent and title would let
 * a flow read some page, create a junk page under it titled with that page's
 * created time, and undo the junk create "from its output", trashing the page
 * it read. The real engine runs both flows here against Connect's own Notion
 * connector behind the kit's port.
 */

import { describe, expect, it } from "vitest";
import type { ActionOutcome, JsonValue } from "@aaply/action-contract";
import { CONFORMANCE_AUDIENCE, conformanceVerifier } from "@aaply/action-contract/conformance";
import { createConnectorActionPort, memoryReplayGuard, operationContracts } from "@aaply/connector-sdk";
import { mockFetch } from "@aaply/connector-sdk/testing";
import { notion, NOTION_API } from "@aaply/connectors/notion";
import { checkActionBindings, compileFlow, pinActionContracts, type FlowDefinition } from "@aaply/flow";
import { createHarness } from "@aaply/flow/testing";

const VICTIM = "11111111-1111-4111-8111-111111111111";
const CREATED = "22222222-2222-4222-8222-222222222222";
const VICTIM_TIME = "2026-01-02T03:04:00.000Z";
const CREATED_TIME = "2026-10-15T11:00:00.000Z";

/** Read a page, create a page under it titled with its created time, wait; cancelling undoes the create with `undo`. */
function flowWith(undo: Record<string, JsonValue>): FlowDefinition {
  return {
    schemaVersion: 3,
    id: "notion-undo",
    version: "1",
    title: "Notion undo",
    facts: { victim: { type: { type: "string" }, sensitivity: "none" }, done: { type: { type: "boolean" } } },
    actions: {
      lookup: { action: "notion.pages.get", effect: "read", input: { pageId: { fact: "victim" } } },
      make: {
        action: "notion.pages.create",
        effect: "write",
        input: { parent: { obj: { pageId: { result: "lookup", path: ["id"] } } }, properties: { obj: { title: { list: [{ obj: { text: { obj: { content: { result: "lookup", path: ["createdTime"] } } } } }] } } } },
        compensate: { action: "notion.pages.removeCreated", input: undo },
      },
    },
    steps: [
      { id: "pick", view: { section: "pick@1" }, on: { submit: { set: { victim: { payload: ["victim"] } } } } },
      { id: "look", run: "lookup" },
      { id: "save", run: "make" },
      { id: "wait", view: { section: "wait@1" }, on: { done: { set: { done: true } } } },
    ],
    completeWhen: { known: "done" },
  } as unknown as FlowDefinition;
}

/** A Notion that answers a create the way Notion does: with the parent and properties it was sent. */
function notionService() {
  const page = (id: string, created: string, extra: Record<string, unknown> = {}) => ({ object: "page", id, url: `https://www.notion.so/${id.replace(/-/g, "")}`, created_time: created, created_by: { object: "user", id: "bot" }, in_trash: false, properties: {}, ...extra });
  return mockFetch({
    [`POST ${NOTION_API}/pages`]: (req) => {
      const body = req.json() as { parent: unknown; properties: { title: [{ text: { content: string } }] } };
      const text = body.properties.title[0].text.content;
      return { json: page(CREATED, CREATED_TIME, { parent: body.parent, properties: { title: { id: "title", type: "title", title: [{ type: "text", text: { content: text }, plain_text: text }] } } }) };
    },
    [`GET ${NOTION_API}/pages/${VICTIM}`]: { json: page(VICTIM, VICTIM_TIME) },
    [`GET ${NOTION_API}/pages/${CREATED}`]: { json: page(CREATED, CREATED_TIME) },
    [`GET ${NOTION_API}/users/me`]: { json: { object: "user", id: "bot", type: "bot" } },
    [`PATCH ${NOTION_API}/pages/*`]: { json: { object: "page", in_trash: true } },
  });
}

async function cancelAfterCreate(undo: Record<string, JsonValue>) {
  const contracts = operationContracts([notion]);
  const pinned = pinActionContracts(flowWith(undo), contracts);
  const compiled = compileFlow(pinned.definition);
  const published = [...pinned.diagnostics, ...compiled.diagnostics, ...(compiled.flow ? checkActionBindings(compiled.flow, contracts, { environment: "production" }) : [])];
  const harness = createHarness({ flows: [pinned.definition], operations: contracts });
  const fetch = notionService();
  const port = createConnectorActionPort({
    audience: CONFORMANCE_AUDIENCE,
    verifier: conformanceVerifier(),
    replayGuard: memoryReplayGuard(harness.clock),
    connectors: [notion],
    connections: () => ({ connectionId: "c", grantedScopes: [], subjectId: null }),
    credentials: { headers: () => ({}) },
    fetch,
    clock: harness.clock,
  });
  const undone: ActionOutcome[] = [];
  for (const op of ["pages.get", "pages.create", "pages.removeCreated"]) {
    harness.actions.on(`notion.${op}`, async (_i, _r, ctx, approved) => {
      const outcome = await port.run(approved, ctx.signal);
      if (op === "pages.removeCreated") undone.push(outcome);
      return outcome;
    });
  }
  const started = await harness.runtime.start(harness.ctx(), { flowId: "notion-undo" });
  const after = await harness.runtime.submit(harness.ctx(), started.runId, { kind: "output", stepId: "pick", name: "submit", payload: { victim: VICTIM } });
  expect(after.view.step?.id).toBe("wait");
  expect(fetch.callsTo(`POST ${NOTION_API}/pages`)).toHaveLength(1);
  await harness.runtime.submit(harness.ctx(), started.runId, { kind: "cancel" });
  await harness.drain();
  return { published: published.filter((d) => d.severity === "error"), undos: harness.actions.callsTo("notion.pages.removeCreated"), undone, trashed: fetch.calls.filter((c) => c.method === "PATCH").map((c) => c.url) };
}

describe("Notion's undo of a create", () => {
  it("cannot be aimed at a page the flow read, through what the create echoes", async () => {
    const { published, undos, undone, trashed } = await cancelAfterCreate({
      pageId: { resource: ["output", "parent", "page_id"] },
      createdTime: { resource: ["output", "properties", "title", "title", 0, "plain_text"] },
    });
    // Every field reads the output, so publish accepts it; but the output holds no parent or title to read.
    expect(published).toEqual([]);
    expect(trashed).toEqual([]);
    expect(undos.map((u) => u.approved.input)).toEqual([{ pageId: null, createdTime: null }]);
    expect(undone).toMatchObject([{ status: "final", error: { code: "connect/invalid-input" } }]);
  });

  it("still trashes the page its create made, and only that one", async () => {
    const { published, undos, undone, trashed } = await cancelAfterCreate({ pageId: { resource: ["output", "id"] }, createdTime: { resource: ["output", "createdTime"] } });
    expect(published).toEqual([]);
    expect(undone).toMatchObject([{ status: "ok" }]);
    expect(undos[0]!.approved).toMatchObject({ purpose: "compensate", undoes: "notion.pages.create", input: { pageId: CREATED, createdTime: CREATED_TIME } });
    expect(trashed).toEqual([`${NOTION_API}/pages/${CREATED}`]);
  });
});
