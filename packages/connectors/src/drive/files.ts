/** Drive's REST calls behind `@aaply/connectors/google-drive`: metadata, search, resumable upload and ranged download. */

import { createHash } from "node:crypto";
import { normalizeMediaType, type BlobRef, type JsonObject, type JsonSchema } from "@aaply/action-contract";
import { ConnectorError, type OperationContext } from "@aaply/connector-sdk";
import { googleOk } from "../google/errors.js";

export const DRIVE_API = "https://www.googleapis.com/drive/v3/files";
export const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";

/** The app property that marks a file this connector uploaded, and names the action that did. Only Aaply's client can see or set it. */
export const CREATED_BY_KEY = "aaplyKey";

/** Every request and response stays under the kit's 5 MiB; Drive wants chunks in multiples of 256 KiB. */
const CHUNK = 4 * 1024 * 1024;

const FIELDS = "id,name,mimeType,size,parents,webViewLink,createdTime,modifiedTime,trashed";

export const DRIVE_ID = "^[A-Za-z0-9_-]{1,200}$";
const driveId = new RegExp(DRIVE_ID);

export const fileSchema: JsonSchema = {
  type: "object",
  required: ["id", "name", "mimeType"],
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    mimeType: { type: "string" },
    size: { type: "integer", minimum: 0 },
    parents: { type: "array", items: { type: "string" } },
    webViewLink: { type: "string" },
    createdTime: { type: "string" },
    modifiedTime: { type: "string" },
    trashed: { type: "boolean" },
  },
  additionalProperties: false,
};

/** A Drive file's metadata, as the operations answer it. */
export type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  size?: number;
  parents?: string[];
  webViewLink?: string;
  createdTime?: string;
  modifiedTime?: string;
  trashed?: boolean;
};

/** Only the fields the output schema names, each checked: Drive adds fields over time. */
export function fileOf(value: unknown): DriveFile {
  const v = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  if (typeof v.id !== "string" || typeof v.name !== "string" || typeof v.mimeType !== "string") throw ConnectorError.final("drive/bad-response", "Drive answered a file without its id, name or type.");
  const out: DriveFile = { id: v.id, name: v.name, mimeType: v.mimeType };
  // Drive answers size as a decimal string.
  if (typeof v.size === "string" && /^\d{1,15}$/.test(v.size)) out.size = Number(v.size);
  if (Array.isArray(v.parents) && v.parents.every((p) => typeof p === "string")) out.parents = v.parents as string[];
  for (const key of ["webViewLink", "createdTime", "modifiedTime"] as const) if (typeof v[key] === "string") out[key] = v[key] as string;
  if (typeof v.trashed === "boolean") out.trashed = v.trashed;
  return out;
}

function checkId(id: string): string {
  if (!driveId.test(id)) throw ConnectorError.final("drive/invalid-id", "That is not a Drive file id.");
  return id;
}

/** A string inside a Drive query: backslashes and single quotes escaped. */
function quoted(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

export async function getFile(ctx: OperationContext, id: string, extra = ""): Promise<{ file: DriveFile; raw: Record<string, unknown> }> {
  const res = googleOk(await ctx.http({ url: `${DRIVE_API}/${checkId(id)}`, query: { fields: extra ? `${FIELDS},${extra}` : FIELDS, supportsAllDrives: true } }), "drive");
  const raw = res.json() as Record<string, unknown>;
  return { file: fileOf(raw), raw };
}

export type ListInput = { nameContains?: string; parentId?: string; mimeType?: string; pageSize?: number; pageToken?: string };

/** The query a list sends: built only from checked values, never a query the caller wrote. */
export function listQuery(input: ListInput): string {
  const terms = ["trashed = false"];
  if (input.nameContains !== undefined) terms.push(`name contains ${quoted(input.nameContains)}`);
  if (input.parentId !== undefined) terms.push(`${quoted(checkId(input.parentId))} in parents`);
  if (input.mimeType !== undefined) terms.push(`mimeType = ${quoted(input.mimeType)}`);
  return terms.join(" and ");
}

export async function listFiles(ctx: OperationContext, input: ListInput): Promise<{ files: DriveFile[]; nextPageToken?: string }> {
  const res = googleOk(
    await ctx.http({ url: DRIVE_API, query: { q: listQuery(input), pageSize: input.pageSize ?? 50, pageToken: input.pageToken, fields: `nextPageToken,files(${FIELDS})`, spaces: "drive" } }),
    "drive",
  );
  const body = res.json() as { files?: unknown; nextPageToken?: unknown };
  const files = Array.isArray(body.files) ? body.files.map(fileOf) : [];
  return { files, ...(typeof body.nextPageToken === "string" ? { nextPageToken: body.nextPageToken } : {}) };
}

/** The mark an upload leaves on its file: from the action's idempotency key, so every attempt of one action finds the same file. */
export function createdMark(idempotencyKey: string): string {
  return createHash("sha256").update(`aaply.drive.upload\n${idempotencyKey}`).digest("hex").slice(0, 40);
}

async function findCreated(ctx: OperationContext, mark: string): Promise<DriveFile | null> {
  const res = googleOk(
    await ctx.http({ url: DRIVE_API, query: { q: `appProperties has { key=${quoted(CREATED_BY_KEY)} and value=${quoted(mark)} } and trashed = false`, pageSize: 1, fields: `files(${FIELDS})`, spaces: "drive" } }),
    "drive",
  );
  const files = (res.json() as { files?: unknown }).files;
  return Array.isArray(files) && files.length > 0 ? fileOf(files[0]) : null;
}

export type UploadInput = { file: BlobRef; name?: string; parentId?: string; description?: string };

/**
 * Uploads a stored file to Drive, once per action: the file carries a mark
 * made from the action's idempotency key, and an attempt that finds a file
 * with its mark answers that file instead of uploading again. The upload is
 * resumable, in 4 MiB chunks, so files larger than one request fit; Drive
 * creates the file only when the last chunk arrives.
 */
export async function upload(ctx: OperationContext, input: UploadInput): Promise<DriveFile> {
  const mark = createdMark(ctx.idempotencyKey);
  const existing = await findCreated(ctx, mark);
  if (existing) return existing;
  const bytes = await ctx.blobs.get(input.file);
  const name = input.name ?? input.file.name ?? "Untitled";
  const metadata: JsonObject = {
    name,
    mimeType: input.file.mediaType,
    appProperties: { [CREATED_BY_KEY]: mark },
    ...(input.parentId !== undefined ? { parents: [checkId(input.parentId)] } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
  };
  const started = googleOk(
    await ctx.http({
      method: "POST",
      url: DRIVE_UPLOAD,
      query: { uploadType: "resumable", supportsAllDrives: true },
      headers: { "x-upload-content-type": input.file.mediaType, "x-upload-content-length": String(bytes.length) },
      json: metadata,
    }),
    "drive",
  );
  const session = started.headers.get("location");
  if (!session || !session.startsWith(`${DRIVE_UPLOAD}?`)) throw ConnectorError.final("drive/bad-response", "Drive did not answer where to send the file.");

  let offset = 0;
  for (;;) {
    const end = Math.min(offset + CHUNK, bytes.length);
    const range = bytes.length === 0 ? "bytes */0" : `bytes ${offset}-${end - 1}/${bytes.length}`;
    const res = await ctx.http({ method: "PUT", url: session, headers: { "content-range": range }, body: bytes.subarray(offset, end) });
    if (res.status === 308) {
      // Drive says how much it holds: carry on from there (it may hold less than was sent).
      const held = /^bytes=0-(\d+)$/.exec(res.headers.get("range") ?? "");
      const next = held ? Number(held[1]) + 1 : 0;
      if (next <= offset && end > offset) throw ConnectorError.retryable("drive/upload-stalled", "Drive kept none of the last part of the file.");
      offset = next;
      continue;
    }
    const done = googleOk(res, "drive").json() as { id?: unknown };
    if (typeof done.id !== "string") throw ConnectorError.unknown("drive/bad-response", "Drive answered the upload without the file's id.");
    return (await getFile(ctx, done.id)).file;
  }
}

/** Google's own formats (Docs, Sheets, Slides) have no bytes; they are exported to one of these. */
export const EXPORT_TYPES = [
  "application/pdf",
  "text/plain",
  "text/csv",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
] as const;

export type DownloadInput = { fileId: string; exportAs?: (typeof EXPORT_TYPES)[number] };

/**
 * Reads a file's content into the file store and answers its reference. A
 * binary file is read in 4 MiB ranges and checked against Drive's MD5, so a
 * file changed half way is not stored as a mix; one of Google's own formats
 * is exported to `exportAs`.
 */
export async function download(ctx: OperationContext, input: DownloadInput): Promise<{ file: BlobRef; source: DriveFile }> {
  const { file, raw } = await getFile(ctx, input.fileId, "md5Checksum");
  let bytes: Uint8Array;
  let mediaType: string;
  if (file.mimeType.startsWith("application/vnd.google-apps.")) {
    if (input.exportAs === undefined) throw ConnectorError.final("drive/export-needed", "This is a Google Docs, Sheets or Slides file: say which format to export it to (exportAs).");
    bytes = googleOk(await ctx.http({ url: `${DRIVE_API}/${checkId(file.id)}/export`, query: { mimeType: input.exportAs } }), "drive").body;
    mediaType = input.exportAs;
  } else {
    const size = file.size ?? 0;
    const parts: Uint8Array[] = [];
    let offset = 0;
    while (offset < size || (size === 0 && parts.length === 0)) {
      const end = Math.min(offset + CHUNK, size) - 1;
      const res = googleOk(
        await ctx.http({ url: `${DRIVE_API}/${checkId(file.id)}`, query: { alt: "media", supportsAllDrives: true }, ...(size > 0 ? { headers: { range: `bytes=${offset}-${end}` } } : {}) }),
        "drive",
      );
      parts.push(res.body);
      // A 200 is the whole file at once.
      offset = res.status === 206 ? offset + res.body.length : size;
      if (res.body.length === 0) break;
    }
    bytes = Buffer.concat(parts);
    const md5 = raw.md5Checksum;
    if (bytes.length !== size || (typeof md5 === "string" && createHash("md5").update(bytes).digest("hex") !== md5)) {
      throw ConnectorError.retryable("drive/changed", "The file changed while it was being read.");
    }
    mediaType = normalizeMediaType(file.mimeType) ?? "application/octet-stream";
  }
  const ref = await ctx.blobs.put(bytes, { mediaType, name: file.name });
  return { file: ref, source: file };
}

/** Moves a file to Drive's trash (recoverable there for 30 days). Trashing a trashed file is no change. */
export async function trash(ctx: OperationContext, id: string): Promise<DriveFile> {
  const res = googleOk(await ctx.http({ method: "PATCH", url: `${DRIVE_API}/${checkId(id)}`, query: { fields: FIELDS, supportsAllDrives: true }, json: { trashed: true } }), "drive");
  return fileOf(res.json());
}

/**
 * The undo of an upload: trashes the file, but only one this connector
 * uploaded (it carries the mark). A file already gone or trashed is done.
 */
export async function removeCreated(ctx: OperationContext, id: string): Promise<{ fileId: string; trashed: true }> {
  let found: { file: DriveFile; raw: Record<string, unknown> };
  try {
    found = await getFile(ctx, id, "appProperties");
  } catch (error) {
    if (ConnectorError.is(error) && error.code === "drive/not-found") return { fileId: id, trashed: true };
    throw error;
  }
  const props = found.raw.appProperties as Record<string, unknown> | undefined;
  if (typeof props?.[CREATED_BY_KEY] !== "string") throw ConnectorError.final("drive/not-created-here", "Only a file this connector uploaded can be removed this way.");
  if (found.file.trashed !== true) await trash(ctx, id);
  return { fileId: id, trashed: true };
}
