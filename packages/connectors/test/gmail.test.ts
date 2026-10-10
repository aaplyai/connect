import { describe, expect, it } from "vitest";
import { testConnector } from "@aaply/connector-sdk/testing";
import { gmail, GMAIL_SEND_URL } from "@aaply/connectors/gmail";
import { buildMessage, encodeSubject } from "../src/gmail/message.js";

const sent = { json: { id: "m1", threadId: "t1", labelIds: ["SENT"] } };
const raw = (body: unknown) => Buffer.from((body as { raw: string }).raw, "base64url").toString("utf8");
const unfold = (message: string) => message.split("\r\n\r\n")[0]!.replace(/\r\n /g, " ");

describe("gmail.send", () => {
  it("sends one message with the account's token and answers its ids", async () => {
    const t = testConnector(gmail, { routes: { [`POST ${GMAIL_SEND_URL}`]: sent } });
    const out = await t.run("send", { to: ["ana@example.com"], cc: ["bo@example.org"], subject: "Your booking", text: "See you at 10." }, { idempotencyKey: "key-1" });
    expect(out).toEqual({ id: "m1", threadId: "t1" });
    const call = t.mock!.calls[0]!;
    expect(call.headers.authorization).toBe("Bearer test-token");
    const message = raw(call.json());
    expect(message).toContain("To: ana@example.com\r\nCc: bo@example.org\r\nSubject: Your booking\r\n");
    const many = buildMessage({ to: Array.from({ length: 50 }, (_, i) => `person.number.${i}@a-rather-long-domain.example.com`), subject: "Hi", text: "x" }, "k");
    for (const line of many.split("\r\n")) expect(line.length).toBeLessThanOrEqual(998);
    expect(unfold(many)).toContain("To: person.number.0@a-rather-long-domain.example.com, person.number.1@");
    expect(message).toContain("Content-Type: text/plain; charset=UTF-8");
    expect(message.split("\r\n\r\n")[1]).toBe(Buffer.from("See you at 10.").toString("base64"));
  });

  it("names the same message for the same action, and another for another", () => {
    const input = { to: ["ana@example.com"], subject: "Hi", text: "x" };
    const id = (key: string) => /Message-ID: (<[^>]+>)/.exec(buildMessage(input, key))![1];
    expect(id("k1")).toBe(id("k1"));
    expect(id("k1")).not.toBe(id("k2"));
    expect(id("k1")).toMatch(/^<[0-9a-f]{40}@aaply\.connect>$/);
  });

  it("refuses header injection and anything but plain addresses, before sending", async () => {
    const t = testConnector(gmail, { routes: { [`POST ${GMAIL_SEND_URL}`]: sent } });
    const bad = [
      { to: ["ana@example.com"], subject: "Hi\r\nBcc: everyone@example.com", text: "x" },
      { to: ["ana@example.com"], subject: "Hi\nX: y", text: "x" },
      { to: ["ana@example.com\r\nBcc: e@example.com"], subject: "Hi", text: "x" },
      { to: ["Ana <ana@example.com>"], subject: "Hi", text: "x" },
      { to: ["ana@example.com, bo@example.com"], subject: "Hi", text: "x" },
      { to: [], subject: "Hi", text: "x" },
      { to: ["ana@example.com"], subject: "Hi", text: "x", from: "boss@example.com" },
    ];
    for (const input of bad) expect((await t.call("send", input)).status, JSON.stringify(input)).toBe("final");
    expect(t.mock!.calls).toEqual([]);
    expect(() => buildMessage({ to: ["a@example.com"], subject: "a\rb", text: "" }, "k")).toThrow(/line break/);
  });

  it("encodes a subject that is not ASCII in whole characters, and sends HTML as an alternative", () => {
    const subject = "बुकिंग की पुष्टि: Dr. Rao, 10:00 ✓";
    const encoded = encodeSubject(subject);
    const words = encoded.split("\r\n ");
    expect(words.length).toBeGreaterThan(1);
    const decoded = words.map((w) => Buffer.from(/^=\?UTF-8\?B\?(.*)\?=$/.exec(w)![1]!, "base64").toString("utf8")).join("");
    expect(decoded).toBe(subject);
    for (const w of words) expect(w.length).toBeLessThanOrEqual(75);

    const message = buildMessage({ to: ["a@example.com"], subject: "Hi", text: "plain", html: "<p>rich</p>" }, "k");
    const boundary = /boundary="([^"]+)"/.exec(message)![1]!;
    expect(message.split(`--${boundary}`).length).toBe(4);
    expect(message).toContain(Buffer.from("<p>rich</p>").toString("base64"));
    expect(unfold(message)).toContain("MIME-Version: 1.0");
  });

  it("answers unknown when the send may have gone out, and never sends twice in one call", async () => {
    const t = testConnector(gmail, { routes: { [`POST ${GMAIL_SEND_URL}`]: { networkError: "ECONNRESET" } } });
    const outcome = await t.call("send", { to: ["ana@example.com"], subject: "Hi", text: "x" });
    expect(outcome.status).toBe("unknown");
    expect(t.mock!.calls.length).toBe(1);
  });

  it("answers final when Gmail refuses the message", async () => {
    const t = testConnector(gmail, { routes: { [`POST ${GMAIL_SEND_URL}`]: { status: 400, json: { error: { message: "Invalid To header" } } } } });
    expect((await t.call("send", { to: ["ana@example.com"], subject: "Hi", text: "x" })).status).toBe("final");
  });
});
