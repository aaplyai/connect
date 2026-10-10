# @aaply/connectors

First-party connectors for Aaply Connect, one subpath each. Each is an ordinary connector-kit
module: a deployment imports the ones it serves and gives them to `createConnect`.

## `@aaply/connectors/gmail`

`gmail.send` sends one email from the connected Google account. It asks only for the `gmail.send`
scope (it cannot read the mailbox), is irreversible, and needs at least a person's confirmation in the
flow (`riskFloor: "confirm"`). Gmail has no idempotency key, so a send whose answer was lost answers
`unknown` and the engine asks a person instead of sending again; the Message-ID is made from the
action's idempotency key. Addresses are plain `name@domain`, no header value may hold a line break,
and a subject that is not ASCII is encoded (RFC 2047).

Connect it with Connect's OAuth (`oauthProviders.google`).
