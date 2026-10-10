/**
 * OAuth providers as data: where to send the person, where to trade a code
 * for tokens, how to learn which account was connected, and how to revoke.
 * A provider is configured once per deployment with Aaply's client for it
 * (`ConnectOptions.oauth`); connectors only name the scopes they need.
 */

export interface OAuthProvider {
  id: string;
  authorizeUrl: string;
  tokenUrl: string;
  /** Where a token is revoked when a connection is removed (RFC 7009 `token=`). */
  revokeUrl?: string;
  /** How the client proves itself at the token endpoint: form fields, or HTTP Basic. */
  clientAuth: "body" | "basic";
  /** The token endpoint takes a form (RFC 6749) or JSON (Notion). Default form. */
  tokenBody?: "form" | "json";
  /** Parameters added to the authorization request (Google: offline access). */
  authorizeParams?: Readonly<Record<string, string>>;
  /** Scopes asked for besides the connector's, to learn the account (Google: openid email). */
  identityScopes?: readonly string[];
  /**
   * Which account was connected: from a JSON endpoint called with the new
   * access token, or from fields of the token response itself, each a
   * dotted path. `id` is the stable account id (a reconnect must match it);
   * `name` is for people; `email` is checked against `expectAccount`, and
   * only when `emailVerified` (if given) is true.
   */
  identity: ({ url: string } | { fromToken: true }) & { id: string; name?: string; email?: string; emailVerified?: string };
  /** The authorization parameter that suggests which account to sign in with (Google: `login_hint`). */
  loginHint?: string;
}

export const oauthProviders = {
  google: {
    id: "google",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    revokeUrl: "https://oauth2.googleapis.com/revoke",
    clientAuth: "body",
    // Offline access for a refresh token; consent each time so Google issues one again on a reconnect.
    // No incremental grants: a connection's token carries only the scopes its connector asked for.
    authorizeParams: { access_type: "offline", prompt: "consent" },
    identityScopes: ["openid", "email"],
    identity: { url: "https://openidconnect.googleapis.com/v1/userinfo", id: "sub", name: "email", email: "email", emailVerified: "email_verified" },
    loginHint: "login_hint",
  },
  notion: {
    id: "notion",
    authorizeUrl: "https://api.notion.com/v1/oauth/authorize",
    tokenUrl: "https://api.notion.com/v1/oauth/token",
    clientAuth: "basic",
    tokenBody: "json",
    authorizeParams: { owner: "user" },
    // The person who authorized, not the workspace: anyone in a workspace could otherwise reconnect as it.
    identity: { fromToken: true, id: "owner.user.id", name: "workspace_name", email: "owner.user.person.email" },
  },
} as const satisfies Record<string, OAuthProvider>;
