# KGI SuperPy Bridge

This migration uses a local Python backend between the React app and KGI:

```text
React frontend -> local Python backend -> KGI client abstraction -> kgisuperpy
```

## Mock Mode

Start the backend:

```bash
KGI_CLIENT_MODE=mock python -m backend.kgi_bridge.server --mode mock --port 21323
```

Start the React frontend in another shell:

```bash
VITE_BROKER=kgi VITE_KGI_BACKEND_BASE=http://127.0.0.1:21323 pnpm dev
```

## Real Mode

Real mode never falls back to mock data. If credentials, `kgisuperpy`, or the
KGI session are unavailable, `/api/v1/health` reports `disconnected`.

Set environment variables in your shell, not in committed files:

```bash
KGI_CLIENT_MODE=real
KGI_PERSON_ID=your_person_id
KGI_PERSON_PWD=your_password
KGI_SIMULATION=true
KGI_ACCOUNT=your_account_id
```

Start the real bridge:

```bash
python -m backend.kgi_bridge.server --mode real --port 21323
```

Test the first real connection:

```bash
curl http://127.0.0.1:21323/api/v1/health
curl http://127.0.0.1:21323/api/v1/auth/accounts
curl -X POST http://127.0.0.1:21323/api/v1/data/snapshots \
  -H "Content-Type: application/json" \
  -d '{"contracts":[{"code":"2330"}]}'
```

Do not consider `RealKGIClient` production-ready until those calls are tested
against an active KGI account. Live order submission, modification, and
cancellation are intentionally disabled.

## Agent Layer

The open-source Agent panel uses the same local bridge. It does not call KGI
directly from React and it does not generate market data in the frontend.

Read-only tool manifest:

```bash
curl http://127.0.0.1:21323/api/v1/agent/tools
```

Execute a tool:

```bash
curl -X POST http://127.0.0.1:21323/api/v1/agent/tools/get_quote \
  -H "Content-Type: application/json" \
  -d '{"symbol":"2330"}'
```

Chat through the local tool-constrained agent:

```bash
curl -X POST http://127.0.0.1:21323/api/v1/agent/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"scan top 5 RSI 90 volume 1","context":{"selectedCode":"2330"}}'
```

Run the deterministic scanner directly:

```bash
curl -X POST http://127.0.0.1:21323/api/v1/scanner/run \
  -H "Content-Type: application/json" \
  -d '{"limit":5,"rsi_max":90,"volume_ratio_min":1,"min_liquidity":1000000}'
```

Current tools are `get_quote`, `get_kbars`, `get_bidask`, `get_positions`,
`get_account`, `get_orders`, `get_deals`, `scan_market`, and
`calculate_indicators`. All are read-only. `get_bidask` works in mock mode;
real synchronous bid/ask lookup is left as a TODO until a verified KGI method is
tested. Future trade ideas must be represented as proposals, pass a Risk
Manager, and receive explicit user confirmation before any order gateway is
allowed to see them.
