# Release Notes

## KGI Migration Foundation

- Migrated the application toward a KGI-only broker architecture.
- Preserved the existing React terminal UI, charts, watchlists, indicators, scanner, and agent panel.
- Added a local Python KGI bridge with mock and real client structure.
- Kept all broker access read-only. Live order submission, modification, and cancellation are still disabled.
- Added mock-mode development flow so the terminal runs without KGI production credentials.

Real KGI connectivity still requires live KGI access and verification against the official SuperPy API.
