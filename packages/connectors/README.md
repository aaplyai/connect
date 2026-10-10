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

## `@aaply/connectors/google-drive`

Files in the connected Google Drive, with only the `drive.file` scope: the connector sees the files
it uploaded and those the person opened with Aaply, never the rest of the Drive. File content moves
by reference through the backend's file store (Connect's `files` option, ADR-0008), so bytes never
pass through the engine.

| Operation | Effect | Notes |
| --- | --- | --- |
| `files.upload` | write, idempotent | Takes a stored file's reference. Runs once per action: the file carries a private mark made from the action's idempotency key, and a retry finds it. Resumable, in 4 MiB chunks. Undo: `files.removeCreated`. |
| `files.get` | read | A file's details. |
| `files.list` | read, paged | By name, folder or type; the query is built from checked values, never passed through. |
| `files.download` | read | Stores the content and answers its reference. Read in 4 MiB ranges and checked against Drive's MD5; Docs, Sheets and Slides are exported to `exportAs`. |
| `files.trash` | write, idempotent, confirm | Moves a file to Drive's trash (restorable for 30 days). |
| `files.removeCreated` | write, idempotent | The undo of an upload: trashes the file only if this connector uploaded it. |

Google's 403 rate limits answer `retryable`. Downloads over 16 MiB need the deployment to raise
`httpLimits.maxTotalResponseBytes`, and files over 25 MiB the file store's `maxBlobBytes`. Two
attempts of one upload running at the same moment could both upload (the engine runs attempts one
after another, so this needs a host bug).

## `@aaply/connectors/notion`

Pages and data sources in the connected Notion workspace, on API version 2025-09-03 (a database
holds data sources; a row is a page under a data source). The connection reaches only the pages the
person shared with Aaply.

| Operation | Effect | Notes |
| --- | --- | --- |
| `pages.create` | write | Under a data source or a page. Notion has no idempotency key, so a lost answer is `unknown` and the engine asks a person. Undo: `pages.removeCreated`. |
| `pages.get` | read | |
| `pages.update` | write, idempotent, confirm | Sets the given properties. |
| `dataSources.query` | read, paged | Notion's own filter and sorts. |
| `search` | read, paged | Pages or data sources by title. |
| `pages.removeCreated` | write, idempotent | Moves the page to the trash, only if this integration created it. |

Property values, filters and blocks are Notion's own JSON, passed on as given. A conflict (409)
answers `retryable`. Connect it with Connect's OAuth (`oauthProviders.notion`); Notion's tokens do
not expire, so Connect renews one only when Notion refuses it.
