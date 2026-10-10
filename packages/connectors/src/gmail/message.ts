/** The message `gmail.send` sends: RFC 5322, built only from checked values. */

import { createHash } from "node:crypto";
import { ConnectorError } from "@aaply/connector-sdk";

export type GmailSendInput = {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  /** The plain-text body (always sent, for mail clients that show no HTML). */
  text: string;
  /** An HTML body, sent as an alternative to the text. */
  html?: string;
};

// A plain address: no display name, comments, quoting or routing (nothing a header could be broken with).
export const EMAIL = "^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$";

const CRLF = "\r\n";
const emailPattern = new RegExp(EMAIL);

/** A header-safe value, or a refusal: the input schema already says this, and the message is built only from checked values. */
function headerValue(name: string, value: string): string {
  if (/[\r\n\0]/.test(value)) throw ConnectorError.final("gmail/invalid-header", `${name} has a line break.`);
  return value;
}

function addresses(name: string, list: readonly string[]): string {
  for (const a of list) if (!emailPattern.test(a)) throw ConnectorError.final("gmail/invalid-address", `${name} has an address that is not name@domain.`);
  return list.join(", ");
}

/** A subject as ASCII: as is, or as RFC 2047 encoded words of at most 45 bytes each (whole characters). */
export function encodeSubject(subject: string): string {
  headerValue("subject", subject);
  if (/^[\x20-\x7e]*$/.test(subject)) return subject;
  const words: string[] = [];
  let chunk = "";
  for (const ch of subject) {
    if (Buffer.byteLength(chunk + ch) > 45) {
      words.push(chunk);
      chunk = "";
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w).toString("base64")}?=`).join(`${CRLF} `);
}

const base64Lines = (text: string) => (Buffer.from(text, "utf8").toString("base64").match(/.{1,76}/g) ?? [""]).join(CRLF);

/** The RFC 5322 message `send` sends. `key` is the action's idempotency key. */
export function buildMessage(input: GmailSendInput, key: string): string {
  const hash = createHash("sha256").update(key).digest("hex");
  const headers = [
    `To: ${addresses("to", input.to)}`,
    ...(input.cc?.length ? [`Cc: ${addresses("cc", input.cc)}`] : []),
    ...(input.bcc?.length ? [`Bcc: ${addresses("bcc", input.bcc)}`] : []),
    `Subject: ${encodeSubject(input.subject)}`,
    `Message-ID: <${hash.slice(0, 40)}@aaply.connect>`,
    "MIME-Version: 1.0",
  ];
  const text = ["Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", base64Lines(input.text)];
  if (input.html === undefined) return [...headers, ...text].join(CRLF);
  // The boundary is base64-free (it has '_' and '.'), so no encoded body can contain it.
  const boundary = `_aaply.${hash.slice(40, 64)}`;
  return [
    ...headers,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    ...text,
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(input.html),
    `--${boundary}--`,
    "",
  ].join(CRLF);
}
