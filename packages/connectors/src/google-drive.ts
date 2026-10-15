/**
 * `@aaply/connectors/google-drive`: files in the connected Google Drive.
 *
 * It asks only for `drive.file`: the connector sees the files it uploaded
 * and those the person opened with Aaply, never the rest of the Drive.
 * File content moves by reference through the host's file store (ADR-0008):
 * `files.upload` takes a stored file's reference and `files.download`
 * answers one, so the bytes never pass through the engine.
 *
 * - `files.upload` (write) runs once per action: the file carries a private
 *   mark made from the action's idempotency key, and a retry that finds its
 *   file answers it. `files.removeCreated` is its undo.
 * - `files.get`, `files.list` (paged) and `files.download` read.
 * - `files.trash` moves a file to Drive's trash and needs at least a
 *   person's confirmation.
 * - `files.removeCreated` trashes only the file one upload made: the flow
 *   passes the upload's `id` and `mark`, and the file must carry that mark.
 *   It is undo-only: a flow names it only as the compensate of
 *   `files.upload`, reading both from the upload's output, and the port
 *   refuses it as a step.
 * - The upload's output holds only what Drive and the connector made (`id`,
 *   `mark`, `webViewLink`, `createdTime`, `modifiedTime`), never the name,
 *   folder or type the flow sent: the undo reads only that output, so an
 *   echo of the flow's own input there (another file's id as the folder, its
 *   mark as the name) could aim it at a file the flow chose.
 *
 * Downloads larger than 16 MiB need the deployment to raise the kit's
 * `maxTotalResponseBytes` (`ConnectOptions.httpLimits`); a file is at most
 * the file store's 25 MiB unless that is raised too.
 */

import { BLOB_REF_SCHEMA, type JsonObject, type JsonSchema } from "@aaply/action-contract";
import { defineConnector } from "@aaply/connector-sdk";
import { DRIVE_ID, EXPORT_TYPES, download, fileSchema, getFile, listFiles, removeCreated, trash, upload, type DownloadInput, type DriveFile, type ListInput, type UploadInput } from "./drive/files.js";

/** What an upload answers: none of its input echoed back. */
const uploadedSchema: JsonSchema = {
  type: "object",
  required: ["id", "mark"],
  properties: { id: { type: "string" }, mark: { type: "string" }, webViewLink: { type: "string" }, createdTime: { type: "string" }, modifiedTime: { type: "string" } },
  additionalProperties: false,
};

function uploaded(file: DriveFile & { mark: string }): JsonObject {
  const out: JsonObject = { id: file.id, mark: file.mark };
  for (const key of ["webViewLink", "createdTime", "modifiedTime"] as const) if (file[key] !== undefined) out[key] = file[key];
  return out;
}

export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file";

const fileId: JsonSchema = { type: "string", pattern: DRIVE_ID };
const byId: JsonSchema = { type: "object", required: ["fileId"], properties: { fileId }, additionalProperties: false };
const plainText = (max: number): JsonSchema => ({ type: "string", minLength: 1, maxLength: max, pattern: "^[^\\u0000-\\u001f]*$" });

export const googleDrive = defineConnector({
  id: "google-drive",
  // 2.0.0: files.removeCreated is undo-only and files.upload answers only what Drive made.
  version: "2.0.0",
  title: "Google Drive",
  description: "Uploads, finds, downloads and trashes files in the connected Google Drive.",
  auth: { kind: "oauth2", scopes: [DRIVE_FILE_SCOPE] },
  egress: ["GET www.googleapis.com/drive/v3/files*", "PATCH www.googleapis.com/drive/v3/files/*", "POST www.googleapis.com/upload/drive/v3/files", "PUT www.googleapis.com/upload/drive/v3/files"],
  operations: {
    "files.upload": {
      title: "Upload a file",
      description: "Uploads a stored file to the Drive, once per action.",
      effect: "write",
      idempotent: true,
      compensate: "files.removeCreated",
      input: {
        type: "object",
        required: ["file"],
        properties: { file: BLOB_REF_SCHEMA, name: plainText(255), parentId: fileId, description: { type: "string", maxLength: 2000 } },
        additionalProperties: false,
      },
      output: uploadedSchema,
      // A file reference is plain JSON; its interface type has no index signature.
      handler: async (input, ctx) => uploaded(await upload(ctx, input as unknown as UploadInput)),
    },
    "files.get": {
      title: "Get a file's details",
      effect: "read",
      input: byId,
      output: fileSchema,
      handler: async (input: { fileId: string }, ctx) => (await getFile(ctx, input.fileId)).file,
    },
    "files.list": {
      title: "Find files",
      description: "Lists files not in the trash, filtered by name, folder or type, a page at a time.",
      effect: "read",
      input: {
        type: "object",
        properties: {
          nameContains: plainText(200),
          parentId: fileId,
          mimeType: { type: "string", maxLength: 255, pattern: "^[a-z0-9.+-]+/[a-z0-9.+-]+$" },
          pageSize: { type: "integer", minimum: 1, maximum: 100 },
          pageToken: { type: "string", maxLength: 2000, pattern: "^[\\x21-\\x7e]+$" },
        },
        additionalProperties: false,
      },
      output: {
        type: "object",
        required: ["files"],
        properties: { files: { type: "array", items: fileSchema }, nextPageToken: { type: "string" } },
        additionalProperties: false,
      },
      handler: (input: ListInput, ctx) => listFiles(ctx, input),
    },
    "files.download": {
      title: "Download a file",
      description: "Reads a file into the file store and answers its reference. Google Docs, Sheets and Slides are exported to exportAs.",
      effect: "read",
      input: { type: "object", required: ["fileId"], properties: { fileId, exportAs: { enum: [...EXPORT_TYPES] } }, additionalProperties: false },
      output: { type: "object", required: ["file", "source"], properties: { file: BLOB_REF_SCHEMA, source: fileSchema }, additionalProperties: false },
      handler: async (input: DownloadInput, ctx) => (await download(ctx, input)) as unknown as JsonObject,
    },
    "files.trash": {
      title: "Move a file to the trash",
      description: "Moves a file to Drive's trash, where it can be restored for 30 days.",
      effect: "write",
      idempotent: true,
      riskFloor: "confirm",
      input: byId,
      output: fileSchema,
      handler: (input: { fileId: string }, ctx) => trash(ctx, input.fileId),
    },
    "files.removeCreated": {
      title: "Remove an uploaded file",
      description: "The undo of an upload: moves the file to the trash, only the file that upload made (its id and mark).",
      effect: "write",
      idempotent: true,
      undoOnly: true,
      input: { type: "object", required: ["fileId", "mark"], properties: { fileId, mark: { type: "string", pattern: "^[0-9a-f]{40}$" } }, additionalProperties: false },
      output: { type: "object", required: ["fileId", "trashed"], properties: { fileId: { type: "string" }, trashed: { const: true } }, additionalProperties: false },
      handler: (input: { fileId: string; mark: string }, ctx) => removeCreated(ctx, input.fileId, input.mark),
    },
  },
});
