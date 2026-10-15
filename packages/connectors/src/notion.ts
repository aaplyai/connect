/**
 * `@aaply/connectors/notion`: pages and data sources in the connected
 * Notion workspace, on Notion's API version 2025-09-03 (databases hold data
 * sources; pages are created under a data source or a page).
 *
 * The connection reaches only the pages the person shared with Aaply when
 * they connected it.
 *
 * - `pages.create` (write) is not idempotent: Notion has no idempotency key,
 *   so a create whose answer was lost answers `unknown` and the engine asks
 *   a person. `pages.removeCreated` is its undo.
 * - `pages.get`, `dataSources.query` and `search` read, a page at a time.
 * - `pages.update` changes a page's properties and needs at least a
 *   person's confirmation.
 * - `pages.removeCreated` moves a page to the trash, only the one a create
 *   made: it takes the page's id and created time from the create's output,
 *   and refuses a page whose creator is not the integration's bot user or
 *   whose created time differs. A page no longer shared with Aaply is
 *   refused, for a person to check, rather than counted as removed.
 *
 * Notion's access tokens do not expire; Connect renews one only when Notion
 * refuses it (401).
 */

import type { JsonObject, JsonSchema, JsonValue } from "@aaply/action-contract";
import { ConnectorError, defineConnector, type ConnectorResponse, type HttpRequest, type OperationContext } from "@aaply/connector-sdk";

export const NOTION_API = "https://api.notion.com/v1";
export const NOTION_VERSION = "2025-09-03";

const ID = "^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$";
const id: JsonSchema = { type: "string", pattern: ID };
const cursor: JsonSchema = { type: "string", maxLength: 1000, pattern: "^[\\x21-\\x7e]+$" };
const pageSize: JsonSchema = { type: "integer", minimum: 1, maximum: 100 };
/** Notion's own JSON (property values, a filter, blocks): passed on as given; Notion checks it. */
const notionObject: JsonSchema = { type: "object" };

const pageSchema: JsonSchema = {
  type: "object",
  required: ["id", "url", "inTrash", "properties"],
  properties: {
    id: { type: "string" },
    url: { type: "string" },
    inTrash: { type: "boolean" },
    createdTime: { type: "string" },
    lastEditedTime: { type: "string" },
    parent: { type: "object" },
    properties: { type: "object" },
  },
  additionalProperties: false,
};

type Page = { id: string; url: string; inTrash: boolean; createdTime?: string; lastEditedTime?: string; parent?: JsonObject; properties: JsonObject };

const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

/** Only the fields the output names: Notion adds fields over time. */
function pageOf(value: unknown): Page {
  const v = isObject(value) ? value : {};
  if (typeof v.id !== "string" || typeof v.url !== "string") throw ConnectorError.final("notion/bad-response", "Notion answered a page without its id or URL.");
  const page: Page = { id: v.id, url: v.url, inTrash: v.in_trash === true || v.archived === true, properties: isObject(v.properties) ? v.properties : {} };
  if (typeof v.created_time === "string") page.createdTime = v.created_time;
  if (typeof v.last_edited_time === "string") page.lastEditedTime = v.last_edited_time;
  if (isObject(v.parent)) page.parent = v.parent;
  return page;
}

/**
 * Notion's answer when 2xx; otherwise the error it means. 404 and a conflict
 * get their own codes, an overload (529) is retryable, and a 503 on a create
 * is `unknown`: Notion says a write may have been saved when it answers 503.
 */
function notionOk(res: ConnectorResponse, creates: boolean): ConnectorResponse {
  if (res.ok) return res;
  if (res.status === 503 && creates) throw ConnectorError.unknown("http/503", "Notion was unavailable; the page may have been created.");
  if (res.status === 529) {
    const seconds = Number(res.headers.get("retry-after") ?? "");
    throw ConnectorError.retryable("http/529", "Notion is overloaded.", { retryAfterMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 5_000 });
  }
  if (res.status === 404) throw ConnectorError.final("notion/not-found", "Notion found no such page, or it was not shared with Aaply.");
  // Notion's conflict_error: a concurrent edit; the same request may succeed again.
  if (res.status === 409) throw ConnectorError.retryable("notion/conflict", "Notion was changing the same page; try again.", { retryAfterMs: 1_000 });
  return res.ensureOk();
}

async function call(ctx: OperationContext, request: Omit<HttpRequest, "headers" | "url"> & { path: string }): Promise<JsonValue> {
  const { path, ...rest } = request;
  const creates = rest.method === "POST" && path === "/pages";
  return notionOk(await ctx.http({ ...rest, url: `${NOTION_API}${path}`, headers: { "notion-version": NOTION_VERSION } }), creates).json();
}

function list(body: JsonValue, item: (value: unknown) => JsonValue): { results: JsonValue[]; nextCursor?: string } {
  const v = isObject(body) ? body : {};
  const results = Array.isArray(v.results) ? v.results.map(item) : [];
  return { results, ...(v.has_more === true && typeof v.next_cursor === "string" ? { nextCursor: v.next_cursor } : {}) };
}

/** A search result: a page or a data source, with its plain title. */
function found(value: unknown): JsonObject {
  const v = isObject(value) ? value : {};
  const title = (rich: unknown) => (Array.isArray(rich) ? rich.map((t) => (isObject(t) && typeof t.plain_text === "string" ? t.plain_text : "")).join("") : "");
  let name = title(v.title);
  if (!name && isObject(v.properties)) {
    for (const p of Object.values(v.properties)) if (isObject(p) && p.type === "title") name = title(p.title);
  }
  return { object: v.object === "data_source" ? "data_source" : "page", id: typeof v.id === "string" ? v.id : "", url: typeof v.url === "string" ? v.url : "", title: name };
}

const listOf = (item: JsonSchema): JsonSchema => ({
  type: "object",
  required: ["results"],
  properties: { results: { type: "array", items: item }, nextCursor: { type: "string" } },
  additionalProperties: false,
});

export const notion = defineConnector({
  id: "notion",
  version: "1.0.0",
  title: "Notion",
  description: "Creates, reads, updates and finds pages in the connected Notion workspace.",
  auth: { kind: "oauth2", scopes: [] },
  egress: ["GET api.notion.com/v1/pages/*", "PATCH api.notion.com/v1/pages/*", "POST api.notion.com/v1/pages", "POST api.notion.com/v1/data_sources/*", "POST api.notion.com/v1/search", "GET api.notion.com/v1/users/me"],
  operations: {
    "pages.create": {
      title: "Create a page",
      description: "Creates a page under a data source (a database row) or under a page.",
      effect: "write",
      compensate: "pages.removeCreated",
      input: {
        type: "object",
        required: ["parent", "properties"],
        properties: {
          parent: {
            anyOf: [
              { type: "object", required: ["dataSourceId"], properties: { dataSourceId: id }, additionalProperties: false },
              { type: "object", required: ["pageId"], properties: { pageId: id }, additionalProperties: false },
            ],
          },
          properties: notionObject,
          children: { type: "array", maxItems: 100, items: { type: "object" } },
        },
        additionalProperties: false,
      },
      output: pageSchema,
      async handler(input: { parent: { dataSourceId: string } | { pageId: string }; properties: JsonObject; children?: JsonObject[] }, ctx) {
        const parent = "dataSourceId" in input.parent ? { type: "data_source_id", data_source_id: input.parent.dataSourceId } : { type: "page_id", page_id: input.parent.pageId };
        const body = await call(ctx, { method: "POST", path: "/pages", json: { parent, properties: input.properties, ...(input.children ? { children: input.children } : {}) } });
        try {
          return pageOf(body);
        } catch {
          throw ConnectorError.unknown("notion/bad-response", "Notion answered the create without the page's id.");
        }
      },
    },
    "pages.get": {
      title: "Get a page",
      effect: "read",
      input: { type: "object", required: ["pageId"], properties: { pageId: id }, additionalProperties: false },
      output: pageSchema,
      handler: async (input: { pageId: string }, ctx) => pageOf(await call(ctx, { path: `/pages/${input.pageId}` })),
    },
    "pages.update": {
      title: "Update a page's properties",
      description: "Sets the given properties of a page; the others stay as they are.",
      effect: "write",
      idempotent: true,
      riskFloor: "confirm",
      input: { type: "object", required: ["pageId", "properties"], properties: { pageId: id, properties: notionObject }, additionalProperties: false },
      output: pageSchema,
      handler: async (input: { pageId: string; properties: JsonObject }, ctx) => pageOf(await call(ctx, { method: "PATCH", path: `/pages/${input.pageId}`, json: { properties: input.properties } })),
    },
    "dataSources.query": {
      title: "Query a data source",
      description: "Lists a data source's pages (a database's rows), filtered and sorted with Notion's own filter and sorts.",
      effect: "read",
      input: {
        type: "object",
        required: ["dataSourceId"],
        properties: { dataSourceId: id, filter: notionObject, sorts: { type: "array", maxItems: 10, items: { type: "object" } }, pageSize, startCursor: cursor },
        additionalProperties: false,
      },
      output: listOf(pageSchema),
      async handler(input: { dataSourceId: string; filter?: JsonObject; sorts?: JsonObject[]; pageSize?: number; startCursor?: string }, ctx) {
        const json: JsonObject = { page_size: input.pageSize ?? 50 };
        if (input.filter) json.filter = input.filter;
        if (input.sorts) json.sorts = input.sorts;
        if (input.startCursor) json.start_cursor = input.startCursor;
        // A wiki's data source lists its child data sources too: only pages are answered.
        const body = await call(ctx, { method: "POST", path: `/data_sources/${input.dataSourceId}/query`, json });
        const results = isObject(body) && Array.isArray(body.results) ? body.results.filter((r) => isObject(r) && r.object === "page") : [];
        return list({ ...(isObject(body) ? body : {}), results }, pageOf);
      },
    },
    search: {
      title: "Search",
      description: "Finds pages or data sources shared with Aaply by title.",
      effect: "read",
      input: {
        type: "object",
        properties: { query: { type: "string", maxLength: 200 }, kind: { enum: ["page", "data_source"] }, pageSize, startCursor: cursor },
        additionalProperties: false,
      },
      output: listOf({
        type: "object",
        required: ["object", "id", "url", "title"],
        properties: { object: { enum: ["page", "data_source"] }, id: { type: "string" }, url: { type: "string" }, title: { type: "string" } },
        additionalProperties: false,
      }),
      async handler(input: { query?: string; kind?: "page" | "data_source"; pageSize?: number; startCursor?: string }, ctx) {
        const json: JsonObject = { page_size: input.pageSize ?? 20 };
        if (input.query) json.query = input.query;
        if (input.kind) json.filter = { property: "object", value: input.kind };
        if (input.startCursor) json.start_cursor = input.startCursor;
        return list(await call(ctx, { method: "POST", path: "/search", json }), found);
      },
    },
    "pages.removeCreated": {
      title: "Remove a created page",
      description: "The undo of a create, given the page's id and created time from the create's output: moves that page to Notion's trash, only if this integration created it.",
      effect: "write",
      idempotent: true,
      input: { type: "object", required: ["pageId", "createdTime"], properties: { pageId: id, createdTime: { type: "string", minLength: 1, maxLength: 64 } }, additionalProperties: false },
      output: { type: "object", required: ["pageId", "inTrash"], properties: { pageId: { type: "string" }, inTrash: { const: true } }, additionalProperties: false },
      async handler(input: { pageId: string; createdTime: string }, ctx) {
        let page: JsonValue;
        try {
          page = await call(ctx, { path: `/pages/${input.pageId}` });
        } catch (error) {
          // Notion answers a trashed page with in_trash; a 404 means it is not shared with Aaply any more, so a person must look.
          if (ConnectorError.is(error) && error.code === "notion/not-found") throw ConnectorError.final("notion/not-accessible", "The page is no longer shared with Aaply, so it could not be removed.");
          throw error;
        }
        const me = await call(ctx, { path: "/users/me" });
        const creator = isObject(page) && isObject(page.created_by) ? page.created_by.id : undefined;
        if (!isObject(me) || typeof me.id !== "string" || creator !== me.id) throw ConnectorError.final("notion/not-created-here", "Only a page this integration created can be removed this way.");
        // The bot made every page Aaply made in the workspace: the created time binds the undo to the one this create made.
        const found = pageOf(page);
        const created = Date.parse(found.createdTime ?? "");
        if (!Number.isFinite(created) || created !== Date.parse(input.createdTime)) throw ConnectorError.final("notion/not-created-here", "Only the page this create made can be removed this way.");
        if (!found.inTrash) await call(ctx, { method: "PATCH", path: `/pages/${input.pageId}`, json: { in_trash: true } });
        return { pageId: input.pageId, inTrash: true };
      },
    },
  },
});
