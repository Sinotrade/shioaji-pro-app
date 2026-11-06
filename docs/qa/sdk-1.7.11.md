# 內建 SDK 1.7.11 升級驗證

驗證日期：2026-11-06（週五，交易日，盤中約 11:03–11:17）。此分支是未發布的 dev build；
App 版本仍由正式 tag 注入，沒有修改 package／Tauri 的占位版本，也沒有打 tag。

## 變更

- `SHIOAJI_VERSION` 改為 `v1.7.11`。Vite 注入的版本握手、release／desktop CI
  下載 URL、`scripts/dev-api.sh` 與 `scripts/build_and_run.sh` 均沿用此單一來源，
  同版本測試 fixture 讀 `EXPECTED_SERVER_VERSION`，不需改測試。
- 工作樹沒有其他地方寫死 `1.7.10`（排除歷史 QA 文件與已發布的發版說明）。

## SDK 比對（v1.7.10..v1.7.11）

SDK tag commit `20dcb3c4be27e635a912d1caf3270ecbe8b8978a`。release 說明三項，tag diff 另有一項：

| SDK 變更 | 原始碼位置 | 對 Pro 的影響 |
| --- | --- | --- |
| 權證（WRT）單被 HTTP server 與 CLI 拒絕 | `server/http/order.rs` `route_place_order`；`api_v1/order/types.rs`、`api.rs`；`cli/commands/order.rs` | STK／WRT 走 `stock_order`，FUT／OPT 走 `futures_order`，送錯種類回 400。對上游（sw、paper）一律送 STK，回傳再還原 WRT。Pro 下單面板、網格、`placeQuickOrder` 的權證單從此可送出。 |
| timeout 後才到的回覆改記 warning | rsolace 0.3.14 → 0.3.16 | 只影響 log 等級。**timeout 不代表沒送到**，見下方「模擬環境延遲」。 |
| 更新內建 TLS 根憑證 | webpki-roots 1.0.7／1.0.9 → 1.0.11（移除不再受信任的 emSign 根憑證） | 登入、合約下載等對外連線實測正常。 |
| 不在 release 說明：log 遮罩 person_id、api_key、account_id | `utils/mask.rs` 與各呼叫點 | 只改 log，給呼叫端的錯誤訊息維持原值（有測試）。Pro 解析的 `Failed to get CA expire` 字串未變（`server-start-error.ts`）。 |

## 實際 sidecar 測試（模擬）

官方 `shioaji-v1.7.11-macOS-aarch64.tar.gz`（SHA-256
`f5d845b0480a0b9d0c97657b278c098006f678ce6df1734a68b26d47a8deaa7f`）在 scratchpad 新的空資料夾解壓。
以隔離埠 `127.0.0.1:21326` 啟動 `server start --no-open`，`SJ_PRODUCTION=false`；`HOME`、
`SJ_HOME_PATH`、`SJ_LOG_DIR`、`SJ_DATASTORE_DIR` 都指到隔離目錄。金鑰只以路徑載入既有設定檔，
未讀出內容，也未帶 CA。沒有探測或操作 21322、8080、21391；只停止本次自己啟動並記下的 PID。
隔離 DataStore 只寫入本次查詢的 3 個 parquet，本次沒有查詢、寫入 `~/.shioaji/data`。

| 項目 | 結果 | 說明 |
| --- | --- | --- |
| `--version` | PASS | `shioaji 1.7.11`。 |
| 啟動／健康檢查 | PASS | `/api/v1/info` 回 `version 1.7.11`、`simulation true`；`/health` 為 healthy。 |
| 登入狀態／帳戶 | PASS | `/auth/accounts` 回 F、S、H 三個帳戶，都已簽署；`/auth/usage` 正常。 |
| 合約 | PASS | `2330`、`TXFK6`、權證 `030392`、`03011T` 查詢正常；2330 權證清單 1273 檔。 |
| kbars | PASS | 2330 `2026-11-04..2026-11-05` 回 532 根，寫入隔離 DataStore。 |
| ticks | PASS | 2330 `2026-11-05` 回 8646 筆；當日 LastCount 3 筆正常。 |
| snapshots | PASS | 2330、TXFK6、030392 都回盤中資料。 |
| 即時行情訂閱 | PASS | `2330`、`TXFK6` 的 Tick／BidAsk 與 `030392` Tick 訂閱成功。第一段 SSE 收到 tick_stk 153、tick_fop 819、bidask_stk 1408、bidask_fop 2173 筆與 heartbeat；030392 收到 tick。取消訂閱後 `market_data` 歸 0。 |
| 模擬下單 TXF | PASS | `TXFK6` 買 1 口 38000 ROD 限價（遠離市價 40523），回 200，order_event 收到 New `00`，`/order/trades` 為 Submitted。 |
| 模擬刪單 TXF | PASS | `/order/cancel_order` 回 200，order_event 收到 Cancel `00`，狀態 Cancelled、`cancel_quantity` 1。無成交。 |
| 權證下單 HTTP | PASS | `030392`（台積電群益64購09）買 1 張 0.01 ROD 限價（跌停價，遠離市價約 1.8），payload 與 Pro `placeStockOrder` 相同。回 200，`contract.security_type` 為 WRT，SSE 收到 StockOrder New `00`，狀態 Submitted。 |
| 權證下單 CLI | PASS | `shioaji order place --code 030392 ...` 回傳 WRT、PendingSubmit，隨後 Submitted。前兩次撞上 paper 延遲，見下方。 |
| 權證刪單 | PASS | HTTP 與 CLI（`order cancel --id`）都刪除成功。5 筆權證單全部 Cancelled、`cancel_quantity` 1，無成交。 |
| 權證送錯種類 | PASS | WRT 帶 `futures_order` 回 400 `WRT contracts take stock_order...`，未碰 session。 |
| 對照組 1.7.10 | PASS | 同一隔離環境、同一筆權證單回 400 `futures_order is required for non-STK contracts`，確認本測試能分辨修正前後。 |
| timeout 後的遲到回覆記 warning | PASS | sidecar log 4 筆 `WARN rsolace::solclient: late reply discarded`（`paper/cancel_order` 1 筆、`paper/place_order` 3 筆），沒有 ERROR。 |
| TLS 根憑證 | 部分 PASS | 登入與合約下載正常，只是沒有壞的間接證據；未單獨驗 emSign 憑證鏈。 |
| Pro 前端接模擬 sidecar 實際下權證單 | 未測 | 本次未起 vite、未操作 UI；上面的 payload 是照 `placeStockOrder` 組的。 |
| 正式環境權證下單 | 未測 | 依規定不在正式環境下單。 |
| Windows／Linux 原生啟動 | 未測 | CI 的 combined-agent 用替身 sidecar，不能當成真實 SDK 啟動的證據。 |

### 模擬環境延遲（paper）

11:05–11:14 模擬後端回應異常慢，11:15 恢復（0.06–0.16 秒）。這段期間的時間線：

| 送出時間 | 操作 | 結果 |
| --- | --- | --- |
| 11:05:19 | TXF 下單 | 200，3.8 秒 |
| 11:05:45 | TXF 刪單 | 200，38.5 秒 |
| 11:06:38 | 權證 HTTP 下單 `04AEA4` | 200，38.7 秒 |
| 11:07:32 | `04AEA4` 刪單 | 測試端 40 秒放棄；11:08:41 遲到回覆寫 warning，刪單其實已生效 |
| 11:08:42 | `04AEA4` 再刪一次 | 200，3.3 秒；第二筆 Cancel 回報 `88`（委託數量已完全刪除） |
| 11:09:08 | 權證 CLI 下單 | 500 Timeout 60 秒；**委託 11:11:28 仍成立**（`04AEDC`） |
| 11:11:11 | 權證 CLI 下單 | 500 Timeout 60 秒；**委託 11:14:42 仍成立** |
| 11:12:55 | 權證 HTTP 下單 | 500 Timeout 60 秒；**委託 11:14:43 仍成立**（與上筆為 `04AEF0`、`04AF17`） |
| 11:15:12 | 權證 CLI 下單 `04AF4D` | 成功，0.16 秒 |

三筆逾時的委託都在發現後刪除。這個延遲的根因沒有查，也沒有拿 1.7.10 在同樣條件下比較，
所以不能排除與 SDK 有關，只能說同一時間 TXF 也慢、不是權證特有。**要記住：`place_order` 回 timeout 不等於沒下單，這次委託在送出後 1 分 48 秒到 3 分 31 秒才成立。**
Pro 把這類 500 視為失敗時的提示文字本次沒有驗證。

### 回報 SDK PM 的發現

- 走 `update_status` 對帳的權證單，`contract.security_type` 是 **STK** 不是 WRT：sidecar 重啟後 5 筆全是
  STK；place 逾時、之後才由對帳補進來的 3 筆也是 STK。只有 place 回應正常回來的才是 WRT（`04AEA4`、`04AF4D`）。
  刪單不受影響。Pro 若以這個欄位再查合約，可能查不到；本次未測 UI 呈現。

## Workaround 盤點（只記錄，本 PR 不改）

Pro 兩邊的 commit 紀錄與程式碼都**沒有為權證被拒做的 workaround**，升版後沒有東西要拆。
但盤點時看到下列權證相關的限制或疑似問題。除另有標註外都是靜態判讀，沒有實測，本 PR 也沒動。

### public

| 位置 | 現況 | 結論 |
| --- | --- | --- |
| `order-ticket.tsx`、`grid-ticket.tsx`、`trade.ts` `isFuturesContract` | WRT 走 `placeStockOrder`，`contractKey` 送 WRT | 不是繞路。1.7.10 這條路會收到 400，1.7.11 起可送出。 |
| `shioaji.ts` `resolveContract` | WRT 不查 `/info`，用占位欄位 | 原因是資料分片，與被拒無關，保留。 |
| `flash-order.tsx` 454、1097、1228 | 判斷式是 `=== 'STK'`，WRT 被當成期貨市場（`F`），選到期貨帳戶 | **疑似問題**：`placeQuickOrder` 要求 WRT 用 S 帳戶（`trade.ts` 211），所以閃電對權證會在本地被拒、不送 HTTP，權證實際上不能用閃電下單。建議另開 issue。 |
| `candle-chart.tsx` 333、419、706 | 333 行 WRT 的 `orderMarket` 是 `null`，419 行選帳戶退回 `S`；706 行局部分類卻是 `F` | 點價下單仍帶 S 帳戶、走 `stock_order`，不會下到期貨帳戶。不一致的是設定、顯示與觸價參數，下單設定按鈕也被隱藏。 |
| `bottom-dock-positions.tsx` 203、`trade.ts` 387 | 判斷式同上，且股數平倉只收 STK | **疑似問題**：權證持倉用底部一鍵平倉會被擋下（`商品與持倉帳戶市場不符`），單子不會送出。 |
| `conditional-form.tsx` 305、`trigger-engine.ts` 854 | 權證顯示「此商品不支援」 | 產品範圍限制，不是為 SDK 做的繞路；要不要開放由 PM 決定。 |

### 私有（`shioaji-pro-desktop`）

唯讀查閱 `DESKTOP_MODULES_REF` `74abdd0067ad0c57dd38ddf196b4dfebcb84d445`（等於目前 `origin/main`），沒有修改私有端檔案或 pin。

| 位置 | 現況 | 結論 |
| --- | --- | --- |
| `src-tauri/src/production_trading.rs` 264 | 只收 STK／FUT／OPT，WRT 回「此合約不支援 Agent 下單」 | 正式環境 Agent 下單不含權證。範圍限制，要開放是另一件事。 |
| `src-tauri/src/execution/` `service.rs` 583、`sidecar.rs` 1873、`core.rs` 2815 | 原生引擎的市場對照只認 STK／FUT／OPT | 同上。 |
| `modules/agent/lib/tools.ts` 1354、`agent-harness.ts` 238 | 只有 STK 用 1000 當單位，其他用 `multiplier` | 權證沒有 multiplier，名目金額可能算不出來。要開放 Agent 權證下單時要一併處理。 |

## 本機驗證

| 檢查 | 結果 |
| --- | --- |
| `pnpm tsc -b` | 通過。 |
| `TZ=UTC pnpm exec vitest run` | 286 files 通過、1 file 略過；4315 tests 通過、2 tests 略過。 |
| `TZ=Asia/Taipei pnpm exec vitest run` | 286 files 通過、1 file 略過；4315 tests 通過、2 tests 略過。 |
| `pnpm build` | 通過（tsc＋Vite）；有既有的 chunk size 與 dynamic import 警告。 |

略過的仍是原本即需 private overlay 的 `indicator-native-integration.test.ts`，本次沒有增加 skip。
沒有啟動原生 dev App。
