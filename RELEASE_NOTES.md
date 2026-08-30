## v0.1.45 - 原生 AI Agent 工作區、技能與交易安全邊界

### Codex、Claude Code、Pi Agent 原生接入

Shioaji Pro 的 AI Agent 不再只是包一層聊天 API。桌面版現在可直接使用 Codex、Claude Code 與 Pi Agent 的原生 runtime，保留各自的登入、模型、推理與工具能力，並由 App 統一提供交易工作區與安全邊界。

- Provider-neutral App Tools：行情、帳戶、版面、技能與交易語意使用同一份版本化契約。
- Agent 對話支援 session 保存、resume／fork、工具執行紀錄、技能選單與背景任務。
- 官方 Shioaji Pro skill／plugin 可安裝到 Codex 與 Claude Code；Pi 使用對應的 native policy。
- Codex 訂閱模型改由 native app-server 的 `model/list` 動態載入，不再受 App 內建清單限制；GPT-5.6 系列與之後新增的帳號可用模型會自動出現（#20）。

![AI Agent 原生 runtime 與交易權限設定](https://raw.githubusercontent.com/Sinotrade/shioaji-pro-app/v0.1.45/docs/images/release-0.1.45-agent-settings.png)

### 交易核准是人看得懂的介面

手動下單確認與 Agent 下單核准已拆成兩套互不混用的控制：

- 手動操作使用原有的可視化委託確認，可在風控設定中控制。
- Agent 提案以方向、商品、價格、數量、帳戶與環境為第一層資訊；完整 payload 與 digest 收在技術細節。
- 核准視窗由 Tauri native 建立，主 WebView 與模型不能自行偽造「已確認」。關窗、逾時或環境不明一律拒絕。
- 模糊的網路／券商結果不會自動重送；App 保留待核對紀錄，讓使用者確認券商端結果後再決定是否可用同一 idempotency key 重試。

### Phase 1 安全界線

- Agent 交易目前只在已驗證的**模擬環境**提供；受限的模擬自動模式仍通過數量、價格、頻率與帳戶風控。
- 正式環境 Agent mutation 維持 fail-closed；人類在交易終端內原有的正式下單不受影響。
- 正式環境逐筆 Agent 核准將在 Shioaji server 支援 one-shot／native IPC secret bootstrap 後開放；正式環境不會提供免確認的全自動權限。

這個界線避免同一使用者下執行的 provider process 取得 sidecar reusable signing secret 後繞過逐筆核准。它是刻意的安全限制，不是 UI 少接一個按鈕。

### 稽核、冪等與程序隔離

- capability secret 隨 sidecar generation 輪替；server restart、runtime stop／exit 會撤銷權限。
- mutation 在外部副作用前持久化 intent，並按環境、帳戶、工具與 idempotency key 隔離。
- keyed audit chain 使用分段輪替與 checkpoint；啟動或人工驗證會做完整檢查，日常 append 維持固定成本。
- Codex／Claude／Pi process tree 在 macOS／Linux 以 process group、Windows 以 Job Object 管理；停止 runtime 會清理 descendants、pending calls 與短期憑證。
- Linux、Windows exact-head composite CI 已涵蓋 frontend、Rust、plugin、Pi policy、Windows TCP owner 與 Job Object E2E。

### 開發與發佈治理

- public／private repo 使用不可變 SHA pin；private 先 merge，public repin 並重跑跨平台 composite 後才能 merge 或打 tag。
- Release build 會再次驗證 `DESKTOP_MODULES_REF` 等於 private `main`，不一致直接停止。

### 相容性

- 內建 Shioaji Server `v1.7.4`；既有手動交易、行情與版面功能不受 Agent Harness 權限影響。
- 深色、純黑與淺色主題完整支援。

---

⚠ Agent 分析與工具輸出僅供參考；模擬自動仍可能產生非預期委託，請先設定風控上限並核對成交結果。正式環境目前不開放 Agent 下單；人類手動正式下單仍會動用真實資金。組合單為真實下單（模擬環境不支援組合單），送出前請確認每腳方向；到價監控會自動送單，請盯緊成交回報。回測結果基於歷史資料與簡化成本假設，不代表未來績效；自動下單請自行評估風險，盈虧自負。

Shioaji Pro 桌面版 - 內建 shioaji server（sidecar）、伺服器管理介面、系統匣、自動更新。

下載：macOS `.dmg` | Windows `.msi` / `.exe` | Linux `.AppImage` / `.deb` / `.rpm`
