import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { blobDigest, type BlobRef } from "@aaply/action-contract";
import { memoryBlobStore, type FetchLike } from "@aaply/connector-sdk";
import { TEST_SCOPE, testConnector } from "@aaply/connector-sdk/testing";
import { googleDrive } from "@aaply/connectors/google-drive";
import { listQuery } from "../src/drive/files.js";

const API = "https://www.googleapis.com/drive/v3/files";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";

type Stored = { id: string; name: string; mimeType: string; bytes: Uint8Array; parents?: string[]; appProperties?: Record<string, string>; trashed: boolean };

/** A Drive that keeps files in memory and speaks the parts of the API the connector uses. */
function fakeDrive(options: { chunkKeep?: (offset: number, length: number) => number; rateLimit?: number } = {}) {
  const files = new Map<string, Stored>();
  const sessions = new Map<string, { meta: Record<string, any>; total: number; got: Uint8Array[]; held: number; done?: string }>();
  const log: string[] = [];
  let next = 1;
  let rateLimit = options.rateLimit ?? 0;
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const meta = (f: Stored) => ({ id: f.id, name: f.name, mimeType: f.mimeType, size: String(f.bytes.length), parents: f.parents ?? ["root"], trashed: f.trashed, md5Checksum: createHash("md5").update(f.bytes).digest("hex"), appProperties: f.appProperties, extra: "ignored" });
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    log.push(`${method} ${url.origin}${url.pathname}${url.searchParams.has("upload_id") ? "?session" : ""}`);
    if (headers.get("authorization") !== "Bearer test-token") return json({ error: { code: 401 } }, 401);
    if (rateLimit > 0) {
      rateLimit--;
      return json({ error: { code: 403, errors: [{ reason: "userRateLimitExceeded" }] } }, 403);
    }
    const body = init.body instanceof Uint8Array ? init.body : typeof init.body === "string" ? new TextEncoder().encode(init.body) : new Uint8Array(0);
    if (url.origin + url.pathname === UPLOAD) {
      if (method === "POST") {
        const id = `s${next++}`;
        sessions.set(id, { meta: JSON.parse(new TextDecoder().decode(body)), total: Number(headers.get("x-upload-content-length")), got: [], held: 0 });
        return new Response(null, { status: 200, headers: { location: `${UPLOAD}?uploadType=resumable&upload_id=${id}` } });
      }
      const s = sessions.get(url.searchParams.get("upload_id")!)!;
      if (s.done) return json({ id: s.done });
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(headers.get("content-range") ?? "");
      if (range) {
        if (Number(range[1]) !== s.held) return json({ error: "bad offset" }, 400);
        const keep = options.chunkKeep ? options.chunkKeep(s.held, body.length) : body.length;
        s.got.push(body.subarray(0, keep));
        s.held += keep;
      }
      if (s.held < s.total) return new Response(null, { status: 308, headers: s.held > 0 ? { range: `bytes=0-${s.held - 1}` } : {} });
      const id = `f${next++}`;
      s.done = id;
      const all = new Uint8Array(Buffer.concat(s.got));
      files.set(id, { id, name: s.meta.name, mimeType: s.meta.mimeType, bytes: all, ...(s.meta.parents ? { parents: s.meta.parents } : {}), appProperties: s.meta.appProperties, trashed: false });
      return json({ id, kind: "drive#file" });
    }
    const path = url.pathname.slice("/drive/v3/files".length);
    if (path === "" && method === "GET") {
      // Shared drives' files are listed only when asked for.
      if (url.searchParams.get("includeItemsFromAllDrives") !== "true" || url.searchParams.get("supportsAllDrives") !== "true") return json({ files: [] });
      const q = url.searchParams.get("q") ?? "";
      const mark = /value='([0-9a-f]+)'/.exec(q)?.[1];
      const named = /name contains '((?:[^'\\]|\\.)*)'/.exec(q)?.[1]?.replace(/\\(.)/g, "$1");
      const found = [...files.values()].filter((f) => !f.trashed && (!mark || f.appProperties?.aaplyKey === mark) && (!named || f.name.includes(named)));
      return json({ files: found.map(meta) });
    }
    const m = /^\/([^/]+)(\/export)?$/.exec(path);
    const f = m ? files.get(m[1]!) : undefined;
    if (!f) return json({ error: { code: 404 } }, 404);
    if (m![2]) return new Response(new TextEncoder().encode(`exported ${f.name} as ${url.searchParams.get("mimeType")}`), { status: 200 });
    if (method === "PATCH") {
      Object.assign(f, JSON.parse(new TextDecoder().decode(body)));
      return json(meta(f));
    }
    if (url.searchParams.get("alt") === "media") {
      const r = /^bytes=(\d+)-(\d+)$/.exec(headers.get("range") ?? "");
      if (!r) return new Response(f.bytes, { status: 200 });
      return new Response(f.bytes.subarray(Number(r[1]), Number(r[2]) + 1), { status: 206 });
    }
    return json(meta(f));
  };
  return { fetch, files, log, put: (f: Omit<Stored, "trashed">) => files.set(f.id, { ...f, trashed: false }) };
}

async function stored(store: ReturnType<typeof memoryBlobStore>, bytes: Uint8Array, mediaType = "application/pdf", name = "report.pdf"): Promise<BlobRef> {
  return store.put(TEST_SCOPE, { bytes, digest: await blobDigest(bytes), size: bytes.length, mediaType, name }, { connectorId: "test", operation: "x", connectionId: "c", effectId: null });
}

const bytesOf = (n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 31) % 251);

describe("google-drive files.upload", () => {
  it("uploads a stored file in chunks, once per action, with the connector's private mark", async () => {
    const drive = fakeDrive();
    const blobs = memoryBlobStore();
    const t = testConnector(googleDrive, { fetch: drive.fetch, blobs, blobLimits: { maxBlobBytes: 26 * 1024 * 1024 } });
    const content = bytesOf(9 * 1024 * 1024 + 7);
    const file = await stored(blobs, content);
    const out = (await t.run("files.upload", { file, parentId: "folder_1" }, { idempotencyKey: "effect-1" })) as Record<string, unknown>;
    // Only what Drive and the connector made: none of the input (name, folder, type) is echoed, so an undo reading the output cannot be aimed by it.
    expect(Object.keys(out).sort()).toEqual(["id", "mark"]);
    const saved = drive.files.get(out.id as string)!;
    expect(saved).toMatchObject({ name: "report.pdf", mimeType: "application/pdf", parents: ["folder_1"] });
    expect(Buffer.compare(saved.bytes, content)).toBe(0);
    expect(saved.appProperties?.aaplyKey).toBe(out.mark);
    expect(drive.log.filter((l) => l === `PUT ${UPLOAD}?session`).length).toBe(3);

    // The same action again (a retry after a lost answer) finds its file and uploads nothing.
    const before = drive.log.length;
    expect(await t.run("files.upload", { file, parentId: "folder_1" }, { idempotencyKey: "effect-1" })).toEqual(out);
    expect(drive.log.slice(before)).toEqual([`GET ${API}`]);
    // Another action uploads its own copy.
    expect(((await t.run("files.upload", { file }, { idempotencyKey: "effect-2" })) as { id: string }).id).not.toBe(out.id);
  });

  it("resends what Drive did not keep of a chunk", async () => {
    const drive = fakeDrive({ chunkKeep: (_offset, length) => (length > 1024 * 1024 ? 1024 * 1024 : length) });
    const blobs = memoryBlobStore();
    const t = testConnector(googleDrive, { fetch: drive.fetch, blobs });
    const content = bytesOf(3 * 1024 * 1024);
    const out = (await t.run("files.upload", { file: await stored(blobs, content) })) as { id: string };
    expect(Buffer.compare(drive.files.get(out.id)!.bytes, content)).toBe(0);
  });

  it("asks the same session what it holds after a part fails, and finishes there instead of starting over", async () => {
    let failNext = 2;
    const drive = fakeDrive();
    const blobs = memoryBlobStore();
    // The second PUT is applied but its answer is a 503: the status query shows the file is complete.
    const flaky: FetchLike = async (input, init) => {
      const res = await drive.fetch(input, init);
      if ((init.method ?? "GET") === "PUT" && new Headers(init.headers).get("content-range")?.startsWith("bytes 4194304") && --failNext === 1) return new Response("{}", { status: 503 });
      return res;
    };
    const t = testConnector(googleDrive, { fetch: flaky, blobs });
    const content = bytesOf(6 * 1024 * 1024);
    const out = (await t.run("files.upload", { file: await stored(blobs, content) })) as { id: string };
    expect(Buffer.compare(drive.files.get(out.id)!.bytes, content)).toBe(0);
    expect(drive.files.size).toBe(1);
    expect(drive.log.filter((l) => l === `POST ${UPLOAD}`).length).toBe(1);
    // Two parts and one status query.
    expect(drive.log.filter((l) => l === `PUT ${UPLOAD}?session`).length).toBe(3);
  });

  it("answers retryable when the upload session is gone, so the action starts over", async () => {
    const drive = fakeDrive();
    const blobs = memoryBlobStore();
    const gone: FetchLike = async (input, init) => ((init.method ?? "GET") === "PUT" ? new Response("Not Found", { status: 404 }) : drive.fetch(input, init));
    const t = testConnector(googleDrive, { fetch: gone, blobs });
    expect(await t.call("files.upload", { file: await stored(blobs, bytesOf(10)) })).toMatchObject({ status: "retryable", error: { code: "drive/upload-expired" } });
  });

  it("uploads an empty file", async () => {
    const drive = fakeDrive();
    const blobs = memoryBlobStore();
    const t = testConnector(googleDrive, { fetch: drive.fetch, blobs });
    const out = (await t.run("files.upload", { file: await stored(blobs, new Uint8Array(0), "text/plain", "empty.txt") })) as { id: string };
    expect(drive.files.get(out.id)!.bytes.length).toBe(0);
  });

  it("refuses a file reference made for another workspace before calling Drive", async () => {
    const drive = fakeDrive();
    const blobs = memoryBlobStore();
    const t = testConnector(googleDrive, { fetch: drive.fetch, blobs });
    const content = bytesOf(10);
    const foreign = await blobs.put({ ...TEST_SCOPE, tenantId: "other" }, { bytes: content, digest: await blobDigest(content), size: 10, mediaType: "application/pdf" }, { connectorId: "t", operation: "x", connectionId: "c", effectId: null });
    expect(await t.call("files.upload", { file: foreign })).toMatchObject({ status: "final", error: { code: "connect/invalid-input" } });
    expect(drive.log).toEqual([]);
  });
});

describe("google-drive reads", () => {
  it("downloads a binary file in ranges into the file store", async () => {
    const drive = fakeDrive();
    const blobs = memoryBlobStore();
    const content = bytesOf(5 * 1024 * 1024 + 3);
    drive.put({ id: "f_big", name: "scan.png", mimeType: "image/png", bytes: content });
    const t = testConnector(googleDrive, { fetch: drive.fetch, blobs });
    const out = (await t.run("files.download", { fileId: "f_big" })) as unknown as { file: BlobRef; source: { name: string } };
    expect(out.file).toMatchObject({ size: content.length, mediaType: "image/png", name: "scan.png" });
    expect(Buffer.compare((await blobs.get(TEST_SCOPE, out.file, { connectorId: "t", operation: "x", connectionId: "c", effectId: null }))!, content)).toBe(0);
    expect(drive.log.filter((l) => l === `GET ${API}/f_big`).length).toBe(3);
  });

  it("exports Google's own formats, and asks for a format when none is given", async () => {
    const drive = fakeDrive();
    const blobs = memoryBlobStore();
    drive.put({ id: "doc1", name: "Notes", mimeType: "application/vnd.google-apps.document", bytes: new Uint8Array(0) });
    const t = testConnector(googleDrive, { fetch: drive.fetch, blobs });
    expect(await t.call("files.download", { fileId: "doc1" })).toMatchObject({ status: "final", error: { code: "drive/export-needed" } });
    const out = (await t.run("files.download", { fileId: "doc1", exportAs: "application/pdf" })) as unknown as { file: BlobRef };
    expect(out.file.mediaType).toBe("application/pdf");
    // The refused call stored nothing; the second stored one file.
    expect(blobs.count).toBe(1);
  });

  it("lists with a query built from checked values only", async () => {
    expect(listQuery({ nameContains: "it's a \\ test", parentId: "abc_1" })).toBe("trashed = false and name contains 'it\\'s a \\\\ test' and 'abc_1' in parents");
    const drive = fakeDrive();
    drive.put({ id: "a1", name: "invoice it's", mimeType: "application/pdf", bytes: bytesOf(3) });
    drive.put({ id: "a2", name: "photo", mimeType: "image/png", bytes: bytesOf(3) });
    const t = testConnector(googleDrive, { fetch: drive.fetch });
    expect(await t.run("files.list", { nameContains: "it's" })).toMatchObject({ files: [{ id: "a1", size: 3 }] });
    expect((await t.call("files.list", { parentId: "x' or name contains '" })).status).toBe("final");
  });

  it("answers Google's 403 rate limit as retryable and a missing file as not found", async () => {
    const t = testConnector(googleDrive, { fetch: fakeDrive({ rateLimit: 1 }).fetch });
    expect(await t.call("files.get", { fileId: "nope" })).toMatchObject({ status: "retryable", error: { code: "http/403" } });
    expect(await t.call("files.get", { fileId: "nope" })).toMatchObject({ status: "final", error: { code: "drive/not-found" } });
  });
});

describe("google-drive trash and undo", () => {
  it("trashes, and undoes only its own uploads, idempotently", async () => {
    const drive = fakeDrive();
    const blobs = memoryBlobStore();
    drive.put({ id: "theirs", name: "Theirs", mimeType: "text/plain", bytes: bytesOf(1) });
    const t = testConnector(googleDrive, { fetch: drive.fetch, blobs });
    const mark = "a".repeat(40);
    expect(await t.call("files.removeCreated", { fileId: "theirs", mark })).toMatchObject({ status: "final", error: { code: "drive/not-created-here" } });
    expect(drive.files.get("theirs")!.trashed).toBe(false);

    const up = (await t.run("files.upload", { file: await stored(blobs, bytesOf(100)) }, { idempotencyKey: "u1" })) as { id: string; mark: string };
    const other = (await t.run("files.upload", { file: await stored(blobs, bytesOf(100)) }, { idempotencyKey: "u2" })) as { id: string; mark: string };
    // Another upload's mark does not undo this one.
    expect(await t.call("files.removeCreated", { fileId: up.id, mark: other.mark })).toMatchObject({ status: "final", error: { code: "drive/not-created-here" } });
    expect(await t.run("files.removeCreated", { fileId: up.id, mark: up.mark })).toEqual({ fileId: up.id, trashed: true });
    expect(drive.files.get(up.id)!.trashed).toBe(true);
    expect(await t.run("files.removeCreated", { fileId: up.id, mark: up.mark })).toEqual({ fileId: up.id, trashed: true });
    expect(await t.run("files.removeCreated", { fileId: "gone", mark })).toEqual({ fileId: "gone", trashed: true });

    expect(await t.run("files.trash", { fileId: "theirs" })).toMatchObject({ id: "theirs", trashed: true });
  });

  it("declares what the engine needs to ask and undo", () => {
    const ops = googleDrive.operations as Record<string, { effect: string; idempotent?: boolean; riskFloor?: string; compensate?: string; undoOnly?: true }>;
    expect(ops["files.upload"]).toMatchObject({ effect: "write", idempotent: true, compensate: "files.removeCreated" });
    expect(ops["files.removeCreated"]).toMatchObject({ effect: "write", idempotent: true, undoOnly: true });
    expect(ops["files.trash"]).toMatchObject({ riskFloor: "confirm" });
    expect(googleDrive.auth).toEqual({ kind: "oauth2", scopes: ["https://www.googleapis.com/auth/drive.file"] });
  });
});
