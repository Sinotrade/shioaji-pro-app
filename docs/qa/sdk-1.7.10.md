# 內建 SDK 1.7.10 升級驗證

驗證日期：2026-11-01（週日）。此分支是未發布的 dev build；App 版本仍由正式 tag
注入，沒有修改 package／Tauri 的占位版本，也沒有打 tag。

## 變更

- `SHIOAJI_VERSION` 改為 `v1.7.10`。Vite 注入的版本握手、release／desktop CI
  下載 URL、`scripts/dev-api.sh` 與 `scripts/build_and_run.sh` 均沿用此單一來源。
- 同版本測試 fixture 在 1.7.9 升版時已改讀 `EXPECTED_SERVER_VERSION`，本次不需改測試。
- 其餘出現 `1.7.9` 的地方都是「某行為從哪一版開始」的歷史敘述（`tauri.ts`、
  `server-diagnostics.ts` 的 receive_window 註解、`docs/qa/startup-timing.md`
  的每日 log、相容性測試名稱）、已發布版本的 `docs/changelog.html` 與
  `RELEASE_NOTES.md`，以及歷史 QA 文件，保留原值。

## SDK 比對（v1.7.9..v1.7.10）

SDK tag commit `8bbfe6bc838485744ee94cb8ec686e1f4ffc5c73`，release 說明三項：

| SDK 變更 | 原始碼位置 | 對 Pro 的影響 |
| --- | --- | --- |
| 正式期貨成交回報 ordno 帶 3 碼成交序號（例如 `v01qs` → `v01qsX1O`）被 SDK trade cache 丟掉（ec666/shioaji !487） | `order/cache.rs`：`futures_deal_base` 取前 5 碼比對委託書號；deal 先到時也只回填 5 碼 | SDK 修的是 trade cache（`/order/trades`、update_status 的成交）。SSE／callback 的原始成交回報在 1.7.9 就已送出（`api/mod.rs` `OrderEventForwarder` 與 cache 結果無關），**ordno 仍是帶尾碼的 8 碼原值**。 |
| DataStore 不再快取 0 筆 ticks／kbars（!488） | `datastore/tick_store.rs`、`kbar_store.rs`、`parquet_store.rs` | 0 筆結果只留在記憶體 TTL；舊版寫下的 0 筆 parquet 會被忽略並重抓。kbars 有部分日期有資料時，無資料日寫 `.holiday` 標記。 |
| 訂閱時拒絕 `*`、`>` 萬用字元代碼 | `stream/topic_code.rs` | HTTP 回 400。Pro 不送這兩個字元；組合商品走巢狀腳訂閱，不受影響。 |

## Workaround 盤點（只記錄，本 PR 不改）

### 期貨成交回報 ordno

| 位置 | 現況 | 結論 |
| --- | --- | --- |
| `src/lib/order-projection.ts` `projectTradeDeal` | 成交回報以 `trade_id`＋帳戶＋商品＋`exchange_seq` 對應委託，不比對 ordno | 沒有為此問題做的繞路，不需改。 |
| `src/lib/shioaji.ts` `prepareOrderMutation` | 失去伺服器基準時以委託的 seqno／ordno 從 `/order/trades` 找回 trade_id；委託列 ordno 是 5 碼 | 不受影響。1.7.10 讓 SDK listing 的成交數量正確，對帳結果更可靠。 |
| `src/lib/order-report.ts` 成交通知 | 顯示 `委託書號 ${ordno}`，正式期貨成交會顯示 8 碼（含成交序號） | 純顯示差異，非本次造成；是否顯示前 5 碼留待之後決定。 |
| 私有 `src-tauri/src/execution/sidecar.rs` `Report::check` | 背景執行引擎把成交回報 ordno 當 second check，與委託已知 ordno 比完全相等；沒有尾碼處理 | **需要保留注意**：正式期貨成交回報的 ordno 是 8 碼，與 New 回報的 5 碼不同，會被判成 `Anomaly`（ordno differ）。這個情況 1.7.9 就存在（原始回報本來就有送出），不是 1.7.10 造成，也不能靠升版解決；建議另開私有端 issue，比照 SDK `futures_deal_base` 處理。 |
| 私有 `modules/agent/lib/approval-fields.ts` | 顯示 `ordno || id` | 只顯示委託，不受影響。 |

### ticks／kbars 0 筆

| 位置 | 現況 | 結論 |
| --- | --- | --- |
| `src/lib/shioaji.ts` `fetchKbars` | 只對逾時／網路／5xx 退避重試，不因 0 筆重抓 | 與本問題無關，保留。 |
| `src/lib/chart-history.ts`、`intraday-chart.tsx` | Pro 自己的記憶體請求快取；手動重新整理或切回進行中時段會換 revision 重抓 | 1.7.9 時 SDK 若已把 0 筆落盤，Pro 重抓也拿回 0 筆；1.7.10 起重抓才真的有效。保留。 |
| `intraday-chart.tsx` 零 kbars 空框架 | 0 筆時先開空的時段框架讓即時資料直接畫 | 正常的盤前／無資料處理，保留。 |
| `tick-tape.tsx`、`vol-profile.tsx` | 錯誤時顯示「重試」；0 筆只顯示空狀態，不自動重抓 | 不是為此問題做的繞路；1.7.10 起換商品或重開面板再查就能拿到資料，保留。 |
| `sparkline.tsx` | 模組層快取 5 分鐘，連失敗結果 `[]` 也快取 | Pro 自己的短期快取；滿 5 分鐘後要等下次觸發載入（換商品或重新掛載）才會重抓，不會定時重抓。與 SDK 修正無關，保留。 |
| 私有 `modules/agent/lib/query-tools.ts` `get_kbars` | 直接呼叫 `fetchKbars`，沒有 0 筆特別處理 | 不需改。 |

私有端唯讀查閱 `shioaji-pro-desktop` 的 `origin/main`
`b514bc36a84c1b04ba531af14a28e5bc4432a3ba`，與本分支 `DESKTOP_MODULES_REF` 一致；
沒有修改私有端檔案或 pin。

## 實際 sidecar 測試（模擬）

官方 `shioaji-v1.7.10-macOS-aarch64.tar.gz`（SHA-256
`c712224c54eb3728d9797a0e61a5d26a27ad0f123d7fe0a1a57a3bd8adac7489`）在新的空資料夾解壓。
以隔離埠 `127.0.0.1:21326`、獨立 `SJ_HOME_PATH`、`SJ_LOG_DIR`、`SJ_DATASTORE_DIR`
啟動 `server start --no-open`，`SJ_PRODUCTION=false`；金鑰只以路徑載入既有設定檔，
未讀出內容。沒有探測或操作 21322、8080、21391，只停止本次自己啟動並記下的 PID。

| 項目 | 結果 | 說明 |
| --- | --- | --- |
| `--version` | PASS | `shioaji 1.7.10`。 |
| 啟動／健康檢查 | PASS | `/api/v1/info` 回 `version 1.7.10`、`simulation true`；`/health` 為 healthy、CA 有效。 |
| 登入狀態／帳戶 | PASS | `/auth/accounts` 回 3 個帳戶（F、S 已簽署，H 未簽署）；`/auth/usage` 正常。 |
| 合約 | PASS | `2330` 與 `TXF` 近月 `TXFK6` 查詢正常。 |
| kbars 一般查詢 | PASS | 2330 `2026-10-29..2026-11-01` 回 531 根（10/29–10/30），寫入兩天 parquet。 |
| ticks 一般查詢 | PASS | 2330 `2026-10-30` 回 7437 筆並寫入 parquet。 |
| 0 筆區間不落盤 | PASS | 2330 kbars `2026-10-31..2026-11-01`（週末）與 ticks `2026-10-31` 都回 0 筆，DataStore 目錄沒有寫入任何檔案。 |
| 舊版 0 筆快取不再卡住 | PASS | 在隔離 DataStore 放入與舊版相同 schema 的 0 列 parquet（2317 kbars／ticks `2026-10-30`），1.7.10 忽略並重抓：kbars 回 266 根、ticks 回 6919 筆，檔案改寫成實際資料；再查一次直接讀磁碟。 |
| 「同區間先 0 筆、之後有資料」的真實情境 | 未測 | 需要後端限流回 0 筆後恢復，無法在本機重現；以上兩項分別驗證「0 筆不落盤」與「舊 0 筆會重抓」。 |
| 即時行情訂閱 | 部分 PASS | `TXFK6` Tick／BidAsk 與 `2330` Tick 訂閱成功，`/monitor/subscriptions` 3 筆、SSE 收到 heartbeat；週日休市，沒有收到行情資料。snapshots 正常。 |
| 模擬下單 TXF | 部分 PASS | `TXFK6` 買 1 口 40000 ROD 限價（遠離市價）回 200，`order_type` 與 `time_in_force` 都是 ROD，狀態 PendingSubmit；週日模擬撮合未開，沒有委託／成交回報，`/order/trades` 查無此單。刪單回 200。 |
| 正式期貨成交回報（!487） | 未測 | 只有正式環境期貨成交才會帶 8 碼成交序號 ordno，模擬回報的 ordno 與委託相同，依規定不在正式環境下單。 |

## 本機驗證

| 檢查 | 結果 |
| --- | --- |
| `pnpm tsc -b` | 通過。 |
| `TZ=UTC pnpm exec vitest run` | 286 files 通過、1 file 略過；4315 tests 通過、2 tests 略過。 |
| `TZ=Asia/Taipei pnpm exec vitest run` | 286 files 通過、1 file 略過；4315 tests 通過、2 tests 略過。 |
| `pnpm build` | 通過（tsc＋Vite）；有既有的 chunk size 警告。 |

略過的仍是原本即需 private overlay 的 `indicator-native-integration.test.ts`，本次沒有增加 skip。
沒有啟動原生 dev App；Windows／Linux 原生啟動與正式環境回報不在本次範圍。
