/**
 * `@aaply/connectors/gmail`: sends email from the connected Google account.
 *
 * It asks only for `gmail.send` (Google's narrowest Gmail scope: it cannot
 * read the mailbox). A sent email cannot be taken back, so `send` is
 * irreversible and needs at least a person's confirmation in the flow.
 *
 * Gmail has no idempotency key, so a send whose answer was lost may have
 * gone out: the kit answers such a call `unknown` and the engine asks a
 * person, rather than sending again. Each message carries a Message-ID made
 * from the action's idempotency key, so the same action always names the
 * same message.
 *
 * Every header value is checked to have no line breaks (no header
 * injection), addresses are plain `name@domain`, and a subject that is not
 * ASCII is encoded (RFC 2047).
 */

import type { JsonSchema } from "@aaply/action-contract";
import { ConnectorError, defineConnector } from "@aaply/connector-sdk";
import { buildMessage, EMAIL, type GmailSendInput } from "./gmail/message.js";

export type { GmailSendInput };

export const GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";

const email: JsonSchema = { type: "string", maxLength: 254, pattern: EMAIL };
const recipients = (min: number): JsonSchema => ({ type: "array", minItems: min, maxItems: 50, items: email });

export const gmail = defineConnector({
  id: "gmail",
  version: "1.0.0",
  title: "Gmail",
  description: "Sends email from the connected Google account.",
  auth: { kind: "oauth2", scopes: [GMAIL_SEND_SCOPE] },
  egress: ["POST gmail.googleapis.com/gmail/v1/users/me/messages/send"],
  operations: {
    send: {
      title: "Send an email",
      description: "Sends one email from the connected account. It cannot be taken back.",
      effect: "write",
      irreversible: true,
      riskFloor: "confirm",
      input: {
        type: "object",
        required: ["to", "subject", "text"],
        properties: {
          to: recipients(1),
          cc: recipients(0),
          bcc: recipients(0),
          subject: { type: "string", minLength: 1, maxLength: 250, pattern: "^[^\\r\\n\\u0000]*$" },
          text: { type: "string", maxLength: 100_000 },
          html: { type: "string", maxLength: 200_000 },
        },
        additionalProperties: false,
      },
      output: {
        type: "object",
        required: ["id", "threadId"],
        properties: { id: { type: "string" }, threadId: { type: "string" } },
        additionalProperties: false,
      },
      async handler(input: GmailSendInput, ctx) {
        const raw = Buffer.from(buildMessage(input, ctx.idempotencyKey), "utf8").toString("base64url");
        const res = await ctx.http({ method: "POST", url: GMAIL_SEND_URL, json: { raw } });
        const sent = res.ensureOk().json() as { id?: unknown; threadId?: unknown };
        if (typeof sent.id !== "string" || typeof sent.threadId !== "string") throw ConnectorError.unknown("connect/bad-response", "Gmail answered without the message's id.");
        return { id: sent.id, threadId: sent.threadId };
      },
    },
  },
});
