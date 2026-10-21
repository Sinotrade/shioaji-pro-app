# 內建 SDK 1.7.9 升級驗證（預計 v0.1.55）

驗證日期：2026-10-20。此分支是未發布的 dev build；App 版本仍由正式 tag
注入，沒有修改 package／Tauri 的占位版本，也沒有打 tag 或 push。

## 變更

- `SHIOAJI_VERSION` 改為 `v1.7.9`。Vite 注入的版本握手、release／desktop CI
  下載 URL、`scripts/dev-api.sh` 與 `scripts/build_and_run.sh` 均沿用此單一來源。
- 開機／Harness 復原測試的同版本伺服器 fixture 改讀
  `EXPECTED_SERVER_VERSION`，避免後續升版遺漏。錯誤分類測試移除不必要的
  固定 SDK 版本名稱，保留舊版錯誤格式的回歸案例。
- `Sign data is timeout` 提示改為「預設 30 秒」，註解記錄 sidecar 1.7.9
  預設 `30000ms`，並新增文字斷言。此值是登入簽章有效窗口，不是 HTTP 請求逾時。
- README 的 CLI 安裝改用 `uv tool install shioaji-cli`，說明 Python 3.14t
  wheel 不含 CLI；桌面版繼續使用官方 standalone binary。
- 新增股票／期貨／組合單的 ROD、IOC、FOK HTTP 邊界回歸，以及啟動失敗後
  讀取 Pro log 的回歸。HTTP 回應是依 SDK 原始碼規格建立的 mock，沒有真實送單。

## SDK 比對與相依盤點

已 fetch tags 並以 SDK 原始碼 `git diff v1.7.8..v1.7.9` 比對；
新 tag commit 為 `171d848cfdd9157e74589baeafaf8170df01400e`。
GitHub origin 的 SSH host key 驗證失敗，HTTPS mirror 沒有新 tag，最後由
SDK 的既有發佈 remote 取得。舊 tag 有差異時未強制覆寫；工作目錄原有變更未動。

| 相依 | 查閱位置與結果 |
| --- | --- |
| 其他軟體委託的刪改單（#244） | SDK `order/cache.rs`、`order/api.rs`、`order/combo_api.rs` 已改用本機登入帳戶補完整簽章身分。Pro `shioaji.ts` 依帳戶類別／券商／帳號辨識，刪改單傳 `trade_id`，不自行建立 SDK trade 或簽章，因此不需前端繞路修正。 |
| receive_window | SDK `utils/receive_window.rs`、CLI 與 token login 路徑確認預設 30000ms；`--receive-window` 優先於 `SJ_RECEIVE_WINDOW`。Pro 沒有寫死 5000ms 的登入設定，只需更新診斷文字。 |
| log 檔案／路徑 | SDK `cli/common.rs` 新增每日檔案，預設在 session dir 下的 `logs/server-<port>/server.<UTC date>.log`，亦可設 `SJ_LOG_DIR`；終端輸出仍保留。Pro `tauri.ts` 讀的是 native shell 自行擷取的 `~/.shioaji/sjpro-server-<port>.log`，不是 SDK 舊 daemon `server.log`。`docs/qa/startup-timing.md` 的路徑仍正確。原生端 stdout/stderr 擷取亦維持相同路徑，無需改讀每日檔案。 |
| client name | 全 repo 與私有 `origin/main` 搜尋 `client_name`、`clientName`、`PYAPI/`、`LOGINING`；沒有解析或依賴名稱格式。診斷僅比對錯誤文字／`LOGINING`，不拆時間段，隨機尾碼不影響判讀。 |
| order_type／time_in_force | SDK `order/tif.rs`、`order/types.rs`、`order/combo_types.rs`、`order/callback.rs` 與 `server/http/order.rs` 確認舊欄位是永久別名；輸入可只傳 `order_type`，HTTP／SSE 保留舊欄位並新增等值的 `time_in_force`。Pro `shioaji.ts`、`trade.ts`、order ticket、grid／combo ticket 繼續傳舊欄位；`order-report.ts`、`order-projection.ts`、`trading-state.ts` 與委託顯示繼續讀舊欄位，沒有排斥新增欄位的 strict schema。本案沒有遷移送單欄位。 |
| server Cargo feature | SDK default feature 已由 `salvo` 改為 `server`。Pro 使用下載的 CLI；`build_and_run.sh` 的本機 SDK build 沒有指定舊 feature，採 default。公私 repo 沒有以 `salvo` feature 編譯 SDK 的設定。`tauri.ts` 註解中的 salvo 是 HTTP logging 元件名稱，並非 Cargo feature。 |
| wheel／CLI 拆包 | release CI 仍下載獨立 binary，與 Python wheel 無關；README 的 Web 使用者安裝指令已修正。沒有其他 `uv tool`／pip CLI 安裝相依。 |

已搜尋公開 repo 的 tracked／隱藏 CI 檔、測試、文件及下載腳本（排除 `.git`、
dependencies、build 產物與 `.env*`）。剩餘 `1.7.8` 僅出現在已發布
v0.1.53／v0.1.54 的 `RELEASE_NOTES.md`、`docs/changelog.html`，以及記錄
instance id／HTTP 錯誤行為從哪一版開始支援的註解；這些歷史敘述保留原值。
沒有仍將目前 sidecar 固定為舊版的設定、fixture 或下載 URL。

## 私有端

唯讀查閱 `shioaji-pro-desktop` 的 `origin/main`，commit
`74e806cabd004080bb3098d0cc3e69e27a1a3e49`，與本分支的
`DESKTOP_MODULES_REF` 一致；沒有使用落後的工作目錄內容作結論。

查閱 native `src-tauri/src/lib.rs` 的 sidecar 啟動、環境與 log 擷取，
`execution/sidecar.rs`／`execution/pending.rs` 的送單序列化，
`production_trading.rs` 的欄位白名單，及 Agent `tool-format.ts`、
`desktop-tools.ts` 的欄位顯示與 CLI 分類。現有請求仍使用 `order_type`，
SDK 1.7.9 接受該欄位；新增回應欄位不會進入送單白名單。
本次升版不需要修改私有端，沒有修改其檔案或 pin。

## 本機驗證

| 檢查 | 結果 |
| --- | --- |
| `pnpm tsc -b` | 通過。 |
| `TZ=UTC pnpm exec vitest run` | 226 files 通過、1 file 略過；3484 tests 通過、2 tests 略過。 |
| `TZ=Asia/Taipei pnpm exec vitest run` | 226 files 通過、1 file 略過；3484 tests 通過、2 tests 略過。 |
| `pnpm build` | 通過（包含 tsc 與 Vite）；有既有 dynamic import chunking 警告。 |
| 官方 macOS arm64 sidecar | `shioaji-v1.7.9-macOS-aarch64.tar.gz` 解壓後，`--version` 回報 `shioaji 1.7.9`。 |
| 真實 binary 離線 smoke | Node assertions 共 6 項通過：版本、模擬／正式兩組 Pro 啟動參數搭配 `--help`、三種舊 `--order-type` 值搭配 `--help`。確認新 receive-window 選項與 30000ms 預設值。 |

略過的是原本即需 private overlay 的 `indicator-native-integration.test.ts`
兩個案例，本次沒有增加 skip。獨立 smoke 的 binary 在乾淨暫存目錄執行，
只傳 PATH、暫存 `SJ_HOME_PATH` 與隔離 `SJ_HTTP_ADDR=127.0.0.1:21323`；
未傳任何券商憑證。所有 `--help` 都在 CLI parse 時結束，沒有啟動 server。

本次未讀取 `.env`、未登入、未啟動連券商的 server、未對 21322／8080
進行探測或操作，亦未使用 `pkill`／`killall`。Vitest 中的原生命令與 HTTP
為 mock。依任務限制，未啟動原生 dev App／SSE 或驗證真實刪改單；#244 的
實際券商行為、Windows／Linux 原生啟動與每日 rotation 是後續有授權環境的
QA 範圍，不能將本次離線測試視為已完成。
