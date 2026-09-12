# 伺服器設定與重啟驗收

設定或 sidecar lifecycle 變更除了 CI，交付前須實測原生 App。React renderer
與 mocked invoke 無法證明 native runtime 已終止、sidecar 已換環境或 SSE 恢復。

## 原生驗收步驟

1. 記錄 App build identity、sidecar PID、目前模式及 SSE 狀態，不記錄金鑰或憑證密碼。
2. 在 App 已有 native Agent 對話的情況下，等對話完成但保留其背景 runtime。
   「對話未執行」不代表 native process 已退出。
3. 在完整設定選擇使用者要求的環境，按「儲存並重啟」。原生 Agent stop 必須
   先完成，然後才停止並重新啟動 App-owned sidecar。
4. 核对舊 Agent process tree 與舊 sidecar 已退出、新 PID 已建立、`/api/v1/info`
   的 `simulation` 正確，原生畫面的模式一致，且 SSE LIVE／heartbeat 恢復。
5. 重新開啟完整設定，核對儲存值與目前運行環境一致，沒有誤留「尚未套用」。
   不以健康檢查或歷史圖表可見代替 SSE 驗證。

切換、停止會結束本 App 的 Agent 與其 runtime 授權；不自動恢复 Auto，也不
重送任何未確認結果的委託。驗收不使用真實下單。外部伺服器由使用者自行管理，
native ownership/lifecycle 拒絕後不可改走 CLI 停止。

## 故障案例（隔離測試）

- Agent stop 失敗或 relist 仍有 running：不儲存立即套用的新設定，不停止 sidecar。
- preflight 後新 runtime 啟動：保留 native kill guard，失敗不繞到 CLI。
- 儲存成功後 sidecar stop 失敗：顯示原始錯誤及「已儲存，尚未套用」。
- 僅儲存與取消草稿：不停止 Agent 或 sidecar。
- 外部 server／未知 IPC 拒絕：不呼叫 CLI fallback。

## 2026-09-12 修正驗收

- 修正前：原生 App 選模擬、儲存重啟後仍為正式，提示 native Agent runtime
  尚在執行。`tauri-server-stop.test.ts` 的兩個原始回歸案例均失敗。
- 修正後：macOS 原生 dev build `2cda4a20` 在同一失敗現場完成正式 → 模擬；
  sidecar PID `14031` → `40622`，API `simulation: true`，SSE LIVE，舊 Agent
  process tree 均已退出。沒有真實下單或新增 Auto 授權。
- Windows/Linux 原生互動與真實 Auto 授權撤銷仍不在本次實機覆蓋範圍；
  跨平台 composite 與 native runtime 測試結果另記於 PR。
