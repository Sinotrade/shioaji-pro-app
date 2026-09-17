# Conservative live pilot gate

This checklist separates build evidence from permission to trade. Passing it
does not enable production or authorize an order.

## Current pilot contract

- Explicit delivery-month contract only; continuous aliases such as `TXFR1`
  and `TXFR2` are quote-only.
- Manual orders only. Agent, trigger, grid and unknown-source orders remain
  blocked in production.
- Maximum quantity is one contract per order.
- The configured daily-loss threshold must be positive and no greater than
  TWD 5,000. This blocks new ordinary orders after the threshold; it does not
  guarantee that realized loss cannot exceed that amount.
- Every manual order requires a visible confirmation.
- The quote stream must be `LIVE`, the latest quote must be no more than 15
  seconds old, and the quote must contain executable data. A market buy needs
  a valid best ask; a market sell needs a valid best bid. A limit order needs
  at least one valid last, bid or ask price.

## Required read-only preflight

Record all values from the same app/server session:

1. App version and reviewed commit or release identifier.
2. Server health and an explicit `simulation` or `production` value.
3. Selected signed account type and masked account identifier.
4. Exact contract code, exchange, product name and delivery month.
5. Stream state, quote receive time, last price, best bid and best ask.
6. Positions and working orders for the selected account.
7. Broker position and margin snapshots used to establish known daily P&L.
8. Risk settings readback: enabled, quantity cap, daily-loss threshold,
   manual confirmation and kill-switch state.

Any missing, stale, ambiguous or conflicting field stops the pilot. Do not
substitute a cached UI value or infer production state from login success.

## Mutation boundary

The first production mutation requires a separate, action-time user approval
that identifies contract, side, quantity, order type, price, account and the
current risk readback. A preview, successful build, simulation fill or PR
merge is not that approval.

After any order mutation, read back positions and working orders. An unknown
outcome is never retried automatically. Cancellation succeeds only after
authoritative readback confirms disappearance, or `Cancelled` with cumulative
cancel quantity covering the remaining quantity.

## External blockers

- The public frontend PR must be reviewed and merged, then included in a
  trusted desktop build whose private overlay tests pass.
- Native unresolved-mutation persistence and the `reconcile_order` recovery
  loop remain an independent desktop-layer requirement tracked by issue #120.
- Installing a candidate build, switching to production and placing the first
  order are separate approval gates.

## Credential boundary

Desktop credentials are stored in the app data `settings.json`, not in this
repository, so routine restart does not require retyping them. This storage is
convenient but is not proof of OS-keyring or hardware-backed protection. Never
commit, paste into logs, or send API, secret, CA or deploy keys through a PR.
