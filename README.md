# Aaply Connect

The side of Aaply that holds credentials and touches the outside world. The
[Flow Engine](https://github.com/aaplyai/flow) decides what should happen and
signs an approved action; Connect checks that approval again, finds the right
account, and performs the action against an API, a database or an app such as
Gmail, Google Drive or Notion. The engine never holds a credential.

## Packages

| Package | What it is |
| --- | --- |
| [`@aaply/connect`](packages/connect) | The service: performs approved actions, holds connections and secrets, runs OAuth and declared SQL connectors. Being built (see the plan's build order). |
| [`@aaply/connectors`](packages/connectors) | First-party connectors, one subpath each (`/gmail` first). |
| [`@aaply/connector-sdk`](packages/connector-sdk) | The public connector kit: define a connector and its operations once, test it, and run it behind the engine's action port. **Vendored** from `aaplyai/flow`, which owns it until both libraries publish to a registry. |
| [`@aaply/action-contract`](packages/action-contract) | The contract between the engine and whatever performs its actions. **Vendored**: a read-only copy owned by `aaplyai/flow`, pinned in its `VENDORED.json`. |

## Documentation

- [Building connectors](packages/connector-sdk/README.md) with the kit.

## Working on it

```sh
pnpm install
pnpm run check          # typecheck and every test
pnpm run vendor:check   # vendored packages match their pinned commit
```

A vendored package is changed in the repository that owns it, then copied
here with `node scripts/vendor.mjs sync packages/<name> <checkout of the owner>`.
