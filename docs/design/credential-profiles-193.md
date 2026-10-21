# 桌面多帳號與系統憑證庫前端整合（desktop #193）

日期：2026-10-20。分支 `feat/193-os-credential-store`。
對應私有 desktop 同名分支；本次不改 `DESKTOP_MODULES_REF`、不 push、不開 PR。
第二次複審結果見下方「第二回合修正」；其餘驗證數字為各輪歷史紀錄。

## 前端資料與指令契約

`DesktopSettings` 是非秘密 read model：`profiles`、`activeProfileId`、`configured`、
`credentialRevision`、backend／遷移診斷，以及非秘密偏好。
`production`、`caPath`、`hasCaPassword` 由 active profile 衍生，方便沿用啟動與診斷流程。
read model 沒有 `apiKey`、`secretKey`、`caPassword` 或 `caPasswd`。

profile 與行動版共用 `id`（UUID）、`name`、`environment`（simulation／production）、
`createdAt`、`hasCA`。桌面另有非秘密 `caPath`、`hasCaPassword`、`apiKeyMasked`、`secretState`、backend 與 revision。
環境在各組編輯，不再另存全域 production。桌面沒有生物辨識設定。

`CredentialDraft` 僅是 write-only 提交資料；已存秘密不預填。表單提交時清空輸入與舊 draft
物件，bridge 在 native 回覆後也移除 payload 中的三個秘密欄位，再進行 server restart／health wait。
更新時秘密欄位省略表示保留；清除 CA 路徑會一併清除 CA 密碼。

| 前端 API | native 指令 |
| --- | --- |
| `loadDesktopSettings` | `credentials_status` |
| `saveDesktopSettings`（只接受偏好） | `credentials_preferences` |
| `saveCredentialProfile` | `credentials_save` |
| `selectCredentialProfile` | `credentials_select` |
| `deleteCredentialProfile` | `credentials_delete` |
| `logoutCredentialProfile` | `credentials_logout` |
| `.env` picker／candidate | `credentials_import_env` |

所有 native 憑證指令只允許 main window；前端也在 IPC 前拒絕子視窗。
`settings.json` 不再由此 bridge 透過 plugin-store 讀寫。
boot／gate 共用一個 in-flight status read；舊 read 或較早的設定回覆不能覆蓋較新的登出狀態。
子視窗仍只接收 `cacheDesktopConfigured` 的布林值。

## 互動決策

- 首次設定與伺服器完整設定共用 `CredentialProfiles`。列表顯示名稱、末四碼遮罩、
  模擬／正式、CA、秘密儲存狀態；圖示為 lucide。
- 新增、切換、刪除均須二次確認；可在同一組編輯環境。
  新增第一組會成為 active，已有帳號時新增不會靜默改變目前環境。
- `.env` 匯入先確認，再選檔或資料夾；有多檔時選候選檔。
  Rust 解析 API keys 與 CA 欄位並立即存成新帳號，前端只接收 profile 索引。
  UI 明確說明匯入會立即保存，不再聲稱取消編輯能撤銷已完成的匯入。
- 「僅儲存」不重啟伺服器；「儲存並啟動／重啟」明確選擇該組並依既有流程停止 Agent／server。
  先完成 native 儲存與格式驗證，再檢查目標帳號的環境／CA／密碼，全部通過才停機與切換。
  操作期間鎖定表單、列表、關閉與對話框的其他動作。
- 切換先停止目前 App 管理的 server／Agent，再選擇 profile；按啟動才以新帳號連線。
  刪除 active 也先停 server；stop 失敗不呼叫 native delete。
- 登出先停止 server／Agent，再由一個 native 指令刪除 active 的整筆秘密（含 CA 密碼），
  清空 active 並重新載入首次設定。其他帳號保留，需明確重新選擇。
- 失敗遷移會顯示「明文設定已保留」，阻止憑證修改；Linux fallback 顯示明文路徑與 0600 警告。
  警告明示同機程式（含 Agent）仍可能讀取；操作錯誤顯示 native 字串或 Error.message。
  登出可在遷移失敗時清除舊三個明文欄位及遷移 pending；系統庫鎖定時保留 pendingDelete 重試。
- 對話框表頭顯示實際服務的模擬／正式與 scheme，不以選擇的 profile 推測。
  Rust 運行中拒絕 select；切換保留 #16 的舊 spawn revision，只有新 spawn 成功才更新。

## Spawn 與 native 儲存

前端 `serverStart`／`spawn_server` payload 不再攜帶任何券商秘密或 SJ_CA_PATH。
Rust 用 active UUID 讀憑證並決定環境，拒絕 renderer 提供這些 env 或替代 CLI 參數。
`spawn_server` 回覆實際 `{pid, credentialRevision}`；前端記錄此 revision。
啟動時與 boot 重新領養現有 server 時都比對 revision，避免使用舊 key 的程序被重新接上。
缺少舊 record 仍採單向相容判斷，避免 restart loop；外部 server 仍保留既有帳號辨識與所有權保護。

native service 是 `<app identifier>.credentials`，account 是純 UUID，值為
`{"apiKey":"…","secretKey":"…","caPassword":"…"}`。開發／QA 指令分別為
`pnpm desktop:dev`／`pnpm desktop:qa`，均載入 private 的 `tauri.dev.conf.json`，
使用 `com.sinotrade.shioaji-pro.dev` 隔離正式資料。revision 改為 HMAC-SHA-256，
機器隨機金鑰只保存在 native 憑證庫（Linux fallback 則在受保護檔）。
settings 只保存非秘密索引。新增／遷移先寫 pending journal，秘密寫入讀回一致後才完成；
舊明文確認安全保存後才刪除。刪除先寫 pendingDelete，確認 NoEntry 後才移除索引，失敗可重試。
macOS／Windows 不退回檔案；Linux 缺 Secret Service 時新 profile 可退回獨立 0600 檔案。
已存在的 system／fallback profile 維持原 backend，避免雙份秘密或靜默降級。
renderer 無 shioaji spawn／execute 權限；原有 status fallback 改用固定參數的
`sidecar_server_status`。通用 plugin-store 權限亦撤銷，Agent 的 sessions、預設／trade／local idempotency 四個資料檔改走
限定檔名的 `renderer_store`；fs deny `native-secrets` 目錄。

本次雙 review 修正的逐項判定、測試與剩餘 P3，見 private
`docs/design/credential-store-193-review-fixes.md`。
修正回合驗證：`pnpm tsc -b`、`pnpm vite build`、UTC／Asia/Taipei 完整 Vitest
各 328 檔／5,784 項通過；native `cargo test --lib` 562 passed／14 ignored，
clippy `--all-targets -- -D warnings`、fmt 通過。未啟動使用者 App／Shioaji 服務或操作既有 Keychain。

## 第二回合修正

- 首次設定頁在 `migrationError` 時提供二次確認的「登出並清除」及取消入口。
  先呼叫 `serverStop({stopAgents:true})`，成功後才 `logoutCredentialProfile`，再清除舊 spawn revision。
  停機失敗顯示原因並保留資料；外部伺服器繼續由既有 ownership guard 保護。
- 首次設定的切換／刪除 active 以及儲存並套用也遵循停機順序；儲存與目標 CA 驗證先於停機，select 先於啟動。
- `.env` 單檔與候選匯入直接顯示 native 的固定字串錯誤；非字串的未知例外保留通用訊息，不揭露例外內容。
- 配對 native 修正四檔白名單並保留原檔名及待對帳資料；Agent shell 在 spawn 前遮斷繼承的全部 `SJ_*`。
  Linux 僅在 D-Bus 成功確認無運行／可啟用 Secret Service 時允許 fallback，存取錯誤不降級、不替換已有系統 HMAC。
  dev config 清空 updater endpoints，避免 QA bundle 更新成正式版。
- 最新驗證：`pnpm tsc -b` 通過；Asia/Taipei／UTC 完整 Vitest 各 330 檔／5,797 項通過；
  native `cargo test --lib` 567 passed／14 ignored、clippy `--all-targets -- -D warnings`、fmt 通過；`pnpm vite build` 通過。
- sidecar 維持 pipe 先遮蔽再寫 log。App 異常退出可能讓 Unix orphan sidecar 寫入 EPIPE；
  改回直接寫原始檔還需收斂 renderer 所有讀取權限與跨 generation 遮蔽，這輪保留並記錄風險。
  renderer 任意 `agent-sh`／`agent-cmd` shell 權限為已知限制，撤銷另案處理。
- 本輪無 push、未修改 `DESKTOP_MODULES_REF`、未讀使用者 `.env`、未操作 Keychain、未啟動伺服器或使用者 App，未用 pkill／killall。
  完整逐項證據與限制見 private `docs/design/credential-store-193-review2-fixes.md`。

## 修改檔案

新增：

- `src/lib/desktop-credentials.ts`
- `src/components/credential-profiles.tsx`
- `docs/design/credential-profiles-193.md`

產品程式與說明：

- `src/app-gate.tsx`
- `src/components/child-setup-notice.tsx`
- `src/components/onboarding-setup.tsx`
- `src/components/server-manager.tsx`
- `src/components/server-settings-dialog.tsx`
- `src/lib/boot.ts`
- `src/lib/desktop-setup-state.ts`
- `src/lib/server-diagnostics.ts`
- `src/lib/sidecar-ownership.ts`
- `src/lib/spawn-keys.ts`
- `src/lib/tauri.ts`
- `src/lib/window-role.ts`

測試：

- `src/app-gate.test.tsx`
- `src/components/onboarding-setup.test.tsx`
- `src/components/server-manager.test.tsx`
- `src/lib/boot-early-stream.test.ts`
- `src/lib/harness-failure-watch.test.ts`
- `src/lib/sidecar-ownership.test.ts`
- `src/lib/spawn-keys.test.ts`
- `src/lib/tauri-env-import.test.ts`
- `src/lib/tauri-settings-access.test.ts`
- `src/lib/tauri-start-path.test.ts`

私有側：`src-tauri/Cargo.toml`、`Cargo.lock`、`src/credentials.rs`、`src/lib.rs`、
`src/webview_capabilities.rs`、`docs/design/credential-store-193.md`。

## 驗證與限制

- 疊合 private modules，`pnpm tsc -b` 通過；完整 vitest 最後一輪
  Asia/Taipei 326 檔／5778 tests 通過。UTC 完整一輪 5777 tests 通過，
  後續新增的 boot revision 回歸亦納入最終 targeted 檢查。
- `pnpm vite build` 通過；只有既有 dynamic-import 分包提醒。
- native `cargo test --lib` 547 passed／14 ignored、clippy `-D warnings`、fmt check 通過。
  原有 ps bearer 測試需 sandbox 外執行，實際檢查的是測試自行建立的假程序。
- macOS 專用假資料 Keychain smoke 通過：不帶 `-w` 查詢確認存在，刪除後確認不存在，
  最後清除測試項目。只操作專用測試 service 與新 UUID。
- Chrome 的隔離假資料設定頁確認列表、切換二次確認、環境／CA 與版面；
  臨時 Vite 24193、分頁與 fixture 已清理。
- 沒有讀使用者 `.env`、既有 Keychain，沒有啟停 Shioaji server／使用者 App，
  沒有存取 21322／8080；測試中的相關數字都是 mock。
- 未在 Windows／Linux 實機驗證，也沒有啟動原生 App 做券商登入或 SSE QA；
  本次 browser fixture／Keychain smoke 的驗證範圍不包含實際交易登入。
- CA 原檔不會被刪除；只清除已存秘密與索引。歷史備份與 JavaScript GC 記憶體殘留無法保證清除。
  sidecar 仍以 env 接收秘密；降版需重新輸入 key。此版未提供不保存的單次輸入模式，
  fallback 不會自動搬回 Secret Service；初始化失敗的重試行為已由下方第三輪修正更新。

合併與發佈前仍須依兩邊 DEV／RELEASE 規範完成 paired review／合成 CI，再處理 pin；
這次只提供兩邊各自的本機 commit。

## 第三輪 review 修正（2026-10-20）

- 帳號變更（含 onboarding、切換與登出）使用 `serverStop` 的 `ownedOnly` 模式：
  先停止 Agent，再停止自有 server；只有外部 server 或沒有 server 時繼續。
  Agent／自有 server 停止失敗仍中止。一般伺服器停止／重啟維持拒絕外部 server。
- 「重試遷移」直接呼叫 native settings/status，透過既有 busy／錯誤處理更新面板。
  配對 desktop 現在只快取成功初始化的 backend，初始化錯誤可在同一 App 內重新探測，
  通訊／存取故障仍不降級明文。
- Desktop 同步修正 Windows 無引號 SET 刪除、只遮蔽實際繼承的 SJ_*、Linux
  NoService 允許新 fallback HMAC，以及無 session bus／ENOENT／ECONNREFUSED 分類。
  權限拒絕／逾時仍回錯。Windows plugin-shell／cmd 與 Linux Secret Service 仍待實機確認。
- 回歸測試重現修改前的外部 server 阻擋、重試按鈕無效與 Windows 命令字串問題；
  `tauri-start-path` 串接帳號停機再啟動，確認保留外部 21322 並改在 21323 啟動。
- `pnpm tsc -b` 通過；完整 Vitest Asia/Taipei／UTC 各 330 檔、5,800 passed、
  1 skipped（Windows-only cmd.exe）。配對 Rust 571 passed、14 ignored，clippy
  `--all-targets -- -D warnings` 與 fmt check 通過。
- 本輪未讀使用者 `.env`、未存取使用者 Keychain、未啟動伺服器或使用者 App。
  Vitest 暫存設定移除 `loadEnv` 並使用 `envDir: false`，測後移除；測試使用假值與 mock。
  不 push、不改 `DESKTOP_MODULES_REF`，兩側各建立本機繁中 commit。
