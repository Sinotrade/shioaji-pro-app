# Privacy

Use the minimum data required for the task. Keep API keys, secrets, certificate
passwords, provider credentials, personal identifiers, account numbers, and raw
certificate material inside App-managed secure storage. Refer to accounts by the
redacted aliases returned by MCP tools.

Before exporting diagnostics, workflows, screenshots, or audit data:

1. Use the App's redacted export when available.
2. Remove secrets, tokens, filesystem credentials, account identifiers, personal
   data, and exact holdings unless the user explicitly needs them locally.
3. Keep reusable workflows parameterized; never embed credentials or account
   identity in skill files, references, logs, fixtures, commits, or pull requests.
4. State what data leaves the device and obtain explicit user approval before
   publishing or sharing it.

Do not read provider credential files or ask the user to paste secrets into the
conversation. Authentication and token refresh belong to each provider's native
runtime and credential store.
