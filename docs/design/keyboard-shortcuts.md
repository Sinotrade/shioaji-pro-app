# 快捷鍵登錄表、設定頁與提示頁

## 結構

- `src/lib/shortcuts/registry.ts`：唯一登錄表。每項有作用範圍（全域／下單面板／
  K 線圖…）、風險（direction／lock／edit／send／cancel）、可改程度（free／
  guarded／fixed）、作用視窗（main／any）。設定頁、提示頁、按鍵比對都讀它。
- `keys.ts`：chord 格式 `Mod+Shift+KeyZ`、`Escape*2`。主鍵用 `KeyboardEvent.code`，
  Caps Lock、注音、macOS Option 都不影響；Mod 在 macOS 是 ⌘，其他平台是 Ctrl。
- `store.ts`：只存與預設不同的鍵（localStorage `sj-pro-shortcuts`，`v: 1`），
  storage 事件同步各視窗；讀回時 sanitize（未知項目、固定鍵、保留鍵、互相衝突者
  回到預設）。
- `match.ts`：`matchesShortcut(id, e)`。舊版各處 ⌘ 與 Ctrl 互通，比對時保留這個
  行為，但明確自訂的 ⌃ 組合優先。
- `guards.ts`：輸入中（含輸入法組字）、視窗角色、目前選取的面板、
  「Esc 由啟用中的面板接手」、錄製時接手鍵盤。

## 產品決定（2026-11-06）的落點

| 決定 | 實作 |
| --- | --- |
| 提示頁 ⌘/（Ctrl+/） | `help.open`，主視窗與彈出視窗都掛 `ShortcutHelpHost`，輸入框內也能叫出 |
| 全部刪單第一版不開放改鍵 | `orders.cancelAll` tier fixed；設定頁只有開關 |
| 閃電下單啟用中 Esc 不算全部刪單第一下 | 閃電下單（與整零價差）armed 時 `holdEscForDisarm()`；use-hotkeys 在 capture 階段記下狀態 |
| Shift+B／S 不觸發，Caps Lock 可以 | chord 以 code＋shiftKey 比對 |
| Windows 停用 F5／Ctrl+R／Ctrl+P | `installBrowserKeyGuard`（Tauri 且非 macOS）在 capture 階段 preventDefault |
| 彈出視窗可開提示頁，交易鍵只在主視窗 | `useHotkeys` 只在 MainApp；項目 `window: 'main'` 在提示頁標「只在主視窗」 |
| B／S 只作用在目前選取的面板 | grid 格加 `data-block-type`；pointerdown／focusin 記下面板；事件帶 `blockId`，下單面板只處理自己的 |
| 頂欄 Agent ⌘J | `agent.toggle` 已登錄（reserved），按下廣播 `sj-shortcut`，Agent popover 用 `onShortcut('agent.toggle', …)` 接手 |

## Windows 瀏覽器按鍵的兩道防線

1. 前端（本 PR）：keydown capture `preventDefault()`。Chromium／WebView2 在網頁
   取消 keydown 時不執行重新載入與列印。前端還沒載入、或畫面卡住時無效。
2. 原生（private repo，待做）：tauri 2.11 沒有公開設定；wry 0.55 的
   `with_browser_accelerator_keys(false)` 也沒有經 tauri 暴露。可在建立視窗後用
   `webview.with_webview(|w| …)` 取得 `ICoreWebView2Settings3` 呼叫
   `SetAreBrowserAcceleratorKeysEnabled(false)`（WebView2 Runtime 92+）。
   這會一併關掉 Ctrl+F 尋找、F12／Ctrl+Shift+I 開發者工具、Ctrl+±縮放等瀏覽器
   功能，但不影響 Ctrl+C／V／X／A／Z 編輯鍵；正式版是否要保留開發者工具需決定。

## #406 送單類快捷鍵：建議的安全設計（未實作）

#406 希望自訂一鍵平倉、刪單、市價買／賣。第一版不加送單鍵；之後若要加：

- 只綁兩個強修飾鍵的組合（例如 ⌘⌥F／Ctrl+Alt+F），不接受單鍵或 Shift＋字母。
- 送出前一律走既有的可視化委託確認（`confirmManualOrders` 關閉時也要確認），
  確認視窗預設焦點在「取消」，Enter 不直接送出。
- 批次市價平倉沿用持倉面板的「解鎖」：未解鎖時按鍵只開啟持倉面板並提示解鎖。
- 只作用在目前選取的下單／持倉面板的帳戶與商品，主視窗限定。
- 預設全部「未設定」，使用者自行指定後才生效；改鍵時跳風險確認。
- 「顯示／隱藏全部畫圖」不影響委託，本版已加入（`chart.toggleDrawings`，預設 ⌥⇧H）。
