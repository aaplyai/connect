import { describe, expect, it } from "vitest";
import { testConnector } from "@aaply/connector-sdk/testing";
import { notion, NOTION_API, NOTION_VERSION } from "@aaply/connectors/notion";

const DS = "1f2e3d4c-5b6a-4789-a0b1-c2d3e4f5a6b7";
const PAGE = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const BOT = "bot-aaply";
const CREATED = "2026-10-10T04:00:00.000Z";

const page = (over: Record<string, unknown> = {}) => ({
  object: "page",
  id: PAGE,
  url: "https://www.notion.so/Booking-aaaa",
  created_time: CREATED,
  last_edited_time: "2026-10-10T04:00:00.000Z",
  created_by: { object: "user", id: BOT },
  in_trash: false,
  parent: { type: "data_source_id", data_source_id: DS },
  properties: { Name: { type: "title", title: [{ plain_text: "Ana, 10:00" }] } },
  icon: null,
  ...over,
});

describe("notion", () => {
  it("creates a row in a data source on API version 2025-09-03, and answers only what Notion made", async () => {
    const t = testConnector(notion, { routes: { [`POST ${NOTION_API}/pages`]: { json: page() } } });
    const properties = { Name: { title: [{ text: { content: "Ana, 10:00" } }] } };
    const out = await t.run("pages.create", { parent: { dataSourceId: DS }, properties });
    // Not the parent or properties it was sent: its undo reads this output, so nothing the flow chose may be in it.
    expect(out).toEqual({ id: PAGE, url: "https://www.notion.so/Booking-aaaa", createdTime: CREATED });
    const sent = t.mock!.calls[0]!;
    expect(sent.headers["notion-version"]).toBe(NOTION_VERSION);
    expect(sent.json()).toEqual({ parent: { type: "data_source_id", data_source_id: DS }, properties });
  });

  it("answers unknown for a create Notion answered without its created time, which its undo needs", async () => {
    const { created_time: _c, ...noTime } = page();
    const t = testConnector(notion, { routes: { [`POST ${NOTION_API}/pages`]: { json: noTime } } });
    expect(await t.call("pages.create", { parent: { pageId: PAGE }, properties: {} })).toMatchObject({ status: "unknown", error: { code: "notion/bad-response" } });
  });

  it("refuses an undo whose created time is not one, before calling Notion", async () => {
    const t = testConnector(notion, { routes: {} });
    // V8 reads this as a date; the undo's input schema does not.
    expect(Date.parse("x Oct 10 2026 04:00:00 GMT")).toBe(Date.parse(CREATED));
    expect(await t.call("pages.removeCreated", { pageId: PAGE, createdTime: "x Oct 10 2026 04:00:00 GMT" })).toMatchObject({ status: "final", error: { code: "connect/invalid-input" } });
    expect(t.mock!.calls).toEqual([]);
  });

  it("answers unknown when a create's answer is lost, so the engine asks instead of creating twice", async () => {
    const t = testConnector(notion, { routes: { [`POST ${NOTION_API}/pages`]: { networkError: "ECONNRESET" } } });
    expect((await t.call("pages.create", { parent: { pageId: PAGE }, properties: {} })).status).toBe("unknown");
    expect(t.mock!.calls.length).toBe(1);
  });

  it("refuses a parent that is neither a data source nor a page, and ids that are not Notion's", async () => {
    const t = testConnector(notion, { routes: {} });
    expect((await t.call("pages.create", { parent: { databaseId: DS }, properties: {} })).status).toBe("final");
    expect((await t.call("pages.get", { pageId: "../users/me" })).status).toBe("final");
    expect(t.mock!.calls).toEqual([]);
  });

  it("queries a data source a page at a time, and searches with titles", async () => {
    const t = testConnector(notion, {
      routes: {
        [`POST ${NOTION_API}/data_sources/${DS}/query`]: { json: { object: "list", results: [page()], has_more: true, next_cursor: "c2" } },
        [`POST ${NOTION_API}/search`]: { json: { results: [{ object: "data_source", id: DS, url: "https://www.notion.so/x", title: [{ plain_text: "Bookings" }] }, page()], has_more: false, next_cursor: null } },
      },
    });
    const q = (await t.run("dataSources.query", { dataSourceId: DS, filter: { property: "Status", status: { equals: "Open" } }, pageSize: 10 })) as { results: unknown[]; nextCursor: string };
    expect(q.nextCursor).toBe("c2");
    expect(t.mock!.calls[0]!.json()).toEqual({ page_size: 10, filter: { property: "Status", status: { equals: "Open" } } });
    expect(await t.run("search", { query: "Book", kind: "data_source" })).toEqual({
      results: [
        { object: "data_source", id: DS, url: "https://www.notion.so/x", title: "Bookings" },
        { object: "page", id: PAGE, url: "https://www.notion.so/Booking-aaaa", title: "Ana, 10:00" },
      ],
    });
    expect(t.mock!.calls[1]!.json()).toEqual({ page_size: 20, query: "Book", filter: { property: "object", value: "data_source" } });
  });

  it("undoes only its own pages, by moving them to the trash, idempotently", async () => {
    const t = testConnector(notion, {
      routes: {
        [`GET ${NOTION_API}/pages/${PAGE}`]: { json: page() },
        [`GET ${NOTION_API}/users/me`]: { json: { object: "user", id: BOT, type: "bot" } },
        [`PATCH ${NOTION_API}/pages/${PAGE}`]: { json: page({ in_trash: true }) },
      },
    });
    expect(await t.run("pages.removeCreated", { pageId: PAGE, createdTime: CREATED })).toEqual({ pageId: PAGE, inTrash: true });
    expect(t.mock!.callsTo(`PATCH ${NOTION_API}/pages/${PAGE}`)[0]!.json()).toEqual({ in_trash: true });

    t.mock!.on(`GET ${NOTION_API}/pages/${PAGE}`, { json: page({ in_trash: true }) });
    await t.run("pages.removeCreated", { pageId: PAGE, createdTime: CREATED });
    expect(t.mock!.callsTo(`PATCH ${NOTION_API}/pages/${PAGE}`).length).toBe(1);

    t.mock!.on(`GET ${NOTION_API}/pages/${PAGE}`, { json: page({ created_by: { object: "user", id: "a-person" } }) });
    expect(await t.call("pages.removeCreated", { pageId: PAGE, createdTime: CREATED })).toMatchObject({ status: "final", error: { code: "notion/not-created-here" } });

    // Not shared any more: a person must look, it is not counted as removed.
    t.mock!.on(`GET ${NOTION_API}/pages/${PAGE}`, { status: 404, json: { object: "error", code: "object_not_found" } });
    expect(await t.call("pages.removeCreated", { pageId: PAGE, createdTime: CREATED })).toMatchObject({ status: "final", error: { code: "notion/not-accessible" } });
  });

  it("undoes only the page its own create made, not another page the integration made", async () => {
    const OTHER = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
    const theirs = page({ id: OTHER, url: "https://www.notion.so/Booking-bbbb", created_time: "2026-10-10T05:00:00.000Z" });
    const t = testConnector(notion, {
      routes: {
        [`POST ${NOTION_API}/pages`]: { json: page() },
        [`GET ${NOTION_API}/pages/${PAGE}`]: { json: page() },
        [`GET ${NOTION_API}/pages/${OTHER}`]: { json: theirs },
        [`GET ${NOTION_API}/users/me`]: { json: { object: "user", id: BOT, type: "bot" } },
        [`PATCH ${NOTION_API}/pages/${PAGE}`]: { json: page({ in_trash: true }) },
        [`PATCH ${NOTION_API}/pages/${OTHER}`]: { json: { ...theirs, in_trash: true } },
      },
    });
    // Two runs each create a page; the bot created both.
    const a = (await t.run("pages.create", { parent: { dataSourceId: DS }, properties: {} })) as { id: string; createdTime: string };
    t.mock!.on(`POST ${NOTION_API}/pages`, { json: theirs });
    const b = (await t.run("pages.create", { parent: { dataSourceId: DS }, properties: {} })) as { id: string; createdTime: string };
    expect(b.id).toBe(OTHER);

    // Run A's undo pointed at run B's page is refused, and nothing is trashed.
    expect(await t.call("pages.removeCreated", { pageId: b.id, createdTime: a.createdTime })).toMatchObject({ status: "final", error: { code: "notion/not-created-here" } });
    expect(t.mock!.callsTo(`PATCH ${NOTION_API}/pages/${OTHER}`)).toEqual([]);
    // An undo without the created time is refused before anything is sent.
    const sent = t.mock!.calls.length;
    expect((await t.call("pages.removeCreated", { pageId: a.id })).status).toBe("final");
    expect(t.mock!.calls.length).toBe(sent);

    // Run A's own undo, from its create's output, still works.
    expect(await t.run("pages.removeCreated", { pageId: a.id, createdTime: a.createdTime })).toEqual({ pageId: PAGE, inTrash: true });
    expect(t.mock!.callsTo(`PATCH ${NOTION_API}/pages/${PAGE}`).length).toBe(1);
  });

  it("answers unknown for a create Notion answered 503, since it may have been saved, and retryable for an overload", async () => {
    const t = testConnector(notion, { routes: { [`POST ${NOTION_API}/pages`]: { status: 503, json: { code: "service_unavailable" } }, [`GET ${NOTION_API}/pages/${PAGE}`]: { status: 529, headers: { "retry-after": "2" }, json: { code: "service_overload" } } } });
    expect(await t.call("pages.create", { parent: { pageId: PAGE }, properties: {} })).toMatchObject({ status: "unknown", error: { code: "http/503" } });
    expect(await t.call("pages.get", { pageId: PAGE })).toMatchObject({ status: "retryable", retryAfterMs: 2000 });
  });

  it("answers only pages from a wiki's data source, which lists child data sources too", async () => {
    const t = testConnector(notion, { routes: { [`POST ${NOTION_API}/data_sources/${DS}/query`]: { json: { results: [{ object: "data_source", id: DS }, page()], has_more: false, next_cursor: null } } } });
    expect(await t.run("dataSources.query", { dataSourceId: DS })).toMatchObject({ results: [{ id: PAGE }] });
  });

  it("answers a conflict as retryable and rate limits with Notion's wait", async () => {
    const t = testConnector(notion, { routes: { [`PATCH ${NOTION_API}/pages/${PAGE}`]: { status: 409, json: { code: "conflict_error" } } } });
    expect(await t.call("pages.update", { pageId: PAGE, properties: {} })).toMatchObject({ status: "retryable", error: { code: "notion/conflict" } });
    t.mock!.on(`PATCH ${NOTION_API}/pages/${PAGE}`, { status: 429, headers: { "retry-after": "3" }, json: { code: "rate_limited" } });
    expect(await t.call("pages.update", { pageId: PAGE, properties: {} })).toMatchObject({ status: "retryable", retryAfterMs: 3000 });
  });
});
