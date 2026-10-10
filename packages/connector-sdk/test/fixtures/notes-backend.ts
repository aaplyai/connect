/**
 * An in-memory notes service behind mock routes: checks the bearer token,
 * de-duplicates creates on the Idempotency-Key header, and pages lists.
 */

import type { JsonObject } from "@aaply/action-contract";
import { mockFetch, type MockFetch, type MockRequest, type MockRoutes } from "../../src/testing.js";
import { NOTES_API } from "./example-notes.js";

export interface RawNote extends JsonObject {
  id: string;
  title: string;
  body: string;
  created_at: string;
  updated_at: string;
}

export interface NotesBackend {
  notes: Map<string, RawNote>;
  routes: MockRoutes;
  fetch: MockFetch;
  /** Adds a note directly. */
  seed(title: string, body?: string): RawNote;
}

export function notesBackend(options: { token?: string } = {}): NotesBackend {
  const token = options.token ?? "test-token";
  const notes = new Map<string, RawNote>();
  const byKey = new Map<string, string>();
  let seq = 0;

  const make = (title: string, body: string): RawNote => {
    seq++;
    const at = new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString();
    const note: RawNote = { id: `n-${String(seq).padStart(4, "0")}`, title, body, created_at: at, updated_at: at };
    notes.set(note.id, note);
    return note;
  };
  const unauthorized = (req: MockRequest) => (req.headers.authorization === `Bearer ${token}` ? null : { status: 401, json: { error: "unauthorized" } });
  const idOf = (url: string) => decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");

  const routes: MockRoutes = {
    [`GET ${NOTES_API}`]: (req) => {
      const denied = unauthorized(req);
      if (denied) return denied;
      const url = new URL(req.url);
      const limit = Number(url.searchParams.get("limit") ?? "20");
      const start = Number(url.searchParams.get("cursor") ?? "0");
      const all = [...notes.values()];
      const items = all.slice(start, start + limit);
      return { json: { items, next_cursor: start + limit < all.length ? String(start + limit) : null } };
    },
    [`GET ${NOTES_API}/*`]: (req) => {
      const denied = unauthorized(req);
      if (denied) return denied;
      const found = notes.get(idOf(req.url));
      return found ? { json: found } : { status: 404, json: { error: "not found" } };
    },
    [`POST ${NOTES_API}`]: (req) => {
      const denied = unauthorized(req);
      if (denied) return denied;
      const key = req.headers["idempotency-key"];
      const previous = key ? byKey.get(key) : undefined;
      if (previous && notes.has(previous)) return { status: 200, headers: { "idempotent-replayed": "true" }, json: notes.get(previous)! };
      const body = req.json() as { title?: string; body?: string };
      if (!body.title) return { status: 422, json: { error: "title is required" } };
      const created = make(body.title, body.body ?? "");
      if (key) byKey.set(key, created.id);
      return { status: 201, json: created };
    },
    [`DELETE ${NOTES_API}/*`]: (req) => {
      const denied = unauthorized(req);
      if (denied) return denied;
      return notes.delete(idOf(req.url)) ? { status: 204 } : { status: 404, json: { error: "not found" } };
    },
  };

  return { notes, routes, fetch: mockFetch(routes), seed: (title, body = "") => make(title, body) };
}
