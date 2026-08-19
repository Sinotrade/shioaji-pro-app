# KGI Pro Trading Terminal

React trading terminal for Taiwan markets, now migrated to a KGI-only local bridge architecture.

The existing terminal UI, charts, watchlists, indicators, scanner, and read-only agent panel are preserved. Broker access flows through the local Python KGI bridge so mock and real modes use the same frontend contract.

## Architecture

```text
React frontend
  -> local Python backend
  -> KGI client abstraction
  -> kgisuperpy
```

The real KGI client is intentionally read-only at this stage. Live order submission, order modification, and cancellation remain disabled until they are explicitly designed, risk-managed, and tested.

## Development

Install frontend dependencies:

```bash
pnpm install
```

Start the Python bridge in mock mode:

```bash
python -m backend.kgi_bridge.server --mode mock --port 21323
```

Start the React frontend:

```bash
pnpm dev
```

Run tests:

```bash
pnpm test
pnpm test:python
```

Build:

```bash
pnpm build
```

## Configuration

Copy `.env.example` to `.env` for local settings. Do not commit `.env`.

KGI credentials must only be supplied to the Python backend through environment variables. Do not use `VITE_` prefixes for credentials because Vite exposes those values to the browser.

## KGI Status

- `MockKGIClient` is available for local development.
- `RealKGIClient` is structured for KGI SuperPy but must not be claimed as production-ready until tested with real KGI access.
- The AI Agent is read-only and must use backend tools for market/account data.
- Scanner output is labeled as screening candidates, not investment recommendations.

## License

AGPL-3.0-only. Keep required copyright and license notices intact.
