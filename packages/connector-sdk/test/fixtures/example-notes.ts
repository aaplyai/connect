/**
 * An example connector for a neutral REST notes service at
 * https://api.example.com/v1/notes. It shows the usual shapes: a paged list,
 * a get that maps 404 to a final error, a create that the service
 * de-duplicates on an Idempotency-Key header (and that `delete` undoes), and
 * a delete that treats "already gone" as success.
 */

import type { JsonObject, JsonSchema, JsonValue } from "@aaply/action-contract";
import { ConnectorError, defineConnector, safe } from "../../src/index.js";

export const NOTES_API = "https://api.example.com/v1/notes";

export type Note = { id: string; title: string; body: string; createdAt: string; updatedAt: string };

const id: JsonSchema = { type: "string", pattern: "^[A-Za-z0-9_-]{1,64}$" };

const note: JsonSchema = {
  type: "object",
  required: ["id", "title", "body", "createdAt", "updatedAt"],
  properties: {
    id,
    title: { type: "string" },
    body: { type: "string" },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
  additionalProperties: false,
};

/** The service speaks snake_case; the connector's contract is camelCase. */
function toNote(raw: JsonValue): Note {
  const r = (raw ?? {}) as JsonObject;
  return { id: r.id as string, title: r.title as string, body: r.body as string, createdAt: r.created_at as string, updatedAt: r.updated_at as string };
}

const noteUrl = (noteId: string) => `${NOTES_API}/${encodeURIComponent(noteId)}`;

export const exampleNotes = defineConnector({
  id: "example-notes",
  version: "1.0.0",
  title: "Example Notes",
  description: "Lists, reads, creates and deletes notes in a REST notes service.",
  auth: { kind: "oauth2", scopes: ["notes.read", "notes.write"] },
  egress: ["GET api.example.com/v1/notes", "GET api.example.com/v1/notes/*", "POST api.example.com/v1/notes", "DELETE api.example.com/v1/notes/*"],
  operations: {
    list: {
      title: "List notes",
      effect: "read",
      input: {
        type: "object",
        properties: { limit: { type: "integer", minimum: 1, maximum: 100 }, cursor: { type: "string", maxLength: 200 } },
        additionalProperties: false,
      },
      output: {
        type: "object",
        required: ["notes", "nextCursor"],
        properties: {
          notes: {
            type: "array",
            items: { type: "object", required: ["id", "title", "updatedAt"], properties: { id, title: { type: "string" }, updatedAt: { type: "string", format: "date-time" } } },
          },
          nextCursor: { type: ["string", "null"] },
        },
      },
      egress: ["GET api.example.com/v1/notes"],
      async handler(input: { limit?: number; cursor?: string }, ctx) {
        const res = await ctx.http({ url: NOTES_API, query: { limit: input.limit ?? 20, cursor: input.cursor } });
        const body = res.ensureOk().json() as { items?: JsonValue[]; next_cursor?: string | null };
        const notes = (body.items ?? []).map((item) => {
          const n = toNote(item);
          return { id: n.id, title: n.title, updatedAt: n.updatedAt };
        });
        ctx.log.info("notes.listed", { count: safe(notes.length) });
        return { notes, nextCursor: body.next_cursor ?? null };
      },
    },

    get: {
      title: "Get a note",
      effect: "read",
      input: { type: "object", required: ["id"], properties: { id }, additionalProperties: false },
      output: note,
      egress: ["GET api.example.com/v1/notes/*"],
      async handler(input: { id: string }, ctx) {
        const res = await ctx.http({ url: noteUrl(input.id) });
        if (res.status === 404) throw ConnectorError.final("notes/not-found", "The note does not exist.");
        return toNote(res.ensureOk().json());
      },
    },

    create: {
      title: "Create a note",
      effect: "write",
      idempotent: true,
      compensate: "delete",
      input: {
        type: "object",
        required: ["title"],
        properties: { title: { type: "string", minLength: 1, maxLength: 200 }, body: { type: "string", maxLength: 20_000 } },
        additionalProperties: false,
      },
      output: note,
      egress: ["POST api.example.com/v1/notes"],
      async handler(input: { title: string; body?: string }, ctx) {
        const res = await ctx.http({
          method: "POST",
          url: NOTES_API,
          headers: { "idempotency-key": ctx.idempotencyKey },
          json: { title: input.title, body: input.body ?? "" },
        });
        const created = toNote(res.ensureOk().json());
        ctx.log.info("notes.created", { id: created.id, replayed: safe(res.headers.get("idempotent-replayed") === "true") });
        return created;
      },
    },

    delete: {
      title: "Delete a note",
      effect: "write",
      idempotent: true,
      input: { type: "object", required: ["id"], properties: { id }, additionalProperties: false },
      output: { type: "object", required: ["id", "deleted"], properties: { id, deleted: { type: "boolean" } }, additionalProperties: false },
      egress: ["DELETE api.example.com/v1/notes/*"],
      async handler(input: { id: string }, ctx) {
        const res = await ctx.http({ method: "DELETE", url: noteUrl(input.id) });
        // Already gone counts as done, which is what makes the delete idempotent.
        if (res.status === 404) return { id: input.id, deleted: false };
        res.ensureOk();
        return { id: input.id, deleted: true };
      },
    },
  },
});
