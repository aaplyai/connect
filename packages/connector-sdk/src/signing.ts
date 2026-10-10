/**
 * Request signing: for a service that authenticates each request by a
 * signature over the request itself (AWS Signature Version 4, and others
 * like it), not by a bearer token.
 *
 * The host's `CredentialProvider.sign` gets the request exactly as it will be
 * sent and returns the headers to add. The kit calls it last, after the body
 * is final and the credential headers are set, once for every credentialed
 * request it sends: every same-origin redirect hop and the resend after a
 * credential refresh is signed afresh. The kit copies the body once into
 * bytes the handler can no longer change, gives the signer a copy, and sends
 * the bytes themselves, so what was signed is what was sent. Signing keys
 * stay in the host: handler code sees neither the hook nor the headers it
 * adds, and those headers never reach another origin.
 */

import { ConnectorError } from "./errors.js";

/** A request as it will be sent, for a signer. */
export interface SignableRequest {
  /** Upper-case method. */
  method: string;
  /** The absolute URL, query included, as sent. */
  url: string;
  /**
   * The request's headers as sent, by lower-case name: the handler's, the
   * credential's and the kit's (`user-agent`, `content-type`). Headers the
   * platform's `fetch` adds on its own (`host`, `content-length`,
   * `accept-encoding`) are not here; sign `host` from `url`.
   */
  headers: Readonly<Record<string, string>>;
  /** The body's exact bytes (a copy), or null when there is none. */
  body: Uint8Array | null;
}

/** Signs one request: the headers to add. Called by the kit's http client for each credentialed request. */
export type RequestSigner = (request: SignableRequest) => Promise<unknown>;

/** Headers the platform sets, which a signer may not add (lower case). */
export const PLATFORM_HEADERS: readonly string[] = ["host", "connection", "content-length", "transfer-encoding", "keep-alive", "upgrade", "te", "trailer", "expect", "proxy-authorization", "proxy-connection"];

/**
 * The headers a signer answered, as `[name, value]` pairs with lower-case
 * names, or a `ConnectorError`: `connect/credential-invalid` (final) when
 * the answer is not an object of string values, names a header the platform
 * sets, or is not a valid header.
 */
export function signatureHeaders(value: unknown): Array<[string, string]> | ConnectorError {
  // The detail names headers, never their values.
  const invalid = (detail: string) => ConnectorError.final("connect/credential-invalid", "The request could not be signed with the connection's credential.", { detail });
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid("the signer did not answer an object of headers");
    const out: Array<[string, string]> = [];
    const check = new Headers();
    for (const [name, header] of Object.entries(value as Record<string, unknown>)) {
      if (typeof header !== "string") return invalid(`the signer's ${name} header is not a string`);
      const lower = name.toLowerCase();
      if (PLATFORM_HEADERS.includes(lower)) return invalid(`the signer may not set the ${lower} header`);
      check.set(name, header);
      out.push([lower, header]);
    }
    return out;
  } catch (error) {
    return ConnectorError.final("connect/credential-invalid", "The request could not be signed with the connection's credential.", { detail: "the signer answered a header that is not valid", cause: error });
  }
}
