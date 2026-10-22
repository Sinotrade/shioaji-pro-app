# 官網版本

GitHub Pages 從 main 的 docs 發布。

- 正式首頁（v2，#156）：https://sinotrade.github.io/shioaji-pro-app/ ，檔案是 index.html，
  搭配 landing-v2.css、landing-v2.js、landing-v2-motion.js。
- 更新紀錄：https://sinotrade.github.io/shioaji-pro-app/changelog.html
- 舊版首頁（v1）：https://sinotrade.github.io/shioaji-pro-app/?landing=v1
  （?landing=original 也可以；檔案是 landing-v1.html，不被搜尋收錄）。
- 舊的 next 方向稿：https://sinotrade.github.io/shioaji-pro-app/?landing=new
- 舊網址 landing-v2.html 會轉回首頁，保留 query 與 hash。

網址選擇不寫入瀏覽器儲存；轉址由 landing-flag.js 處理，JavaScript 無法載入時首頁仍顯示 v2。

## 待確認的註記

API Key 教學裡標 class="tu-tbd" 的段落是還沒查證的說明（API Key 能否暫停、到期時間範圍、
期貨類簽署項目名稱、模擬測試審核時間），目前用 CSS 隱藏不對外顯示。查證後改寫內文並移除該段。

## 截圖

首屏與面板截圖由 scripts/capture-landing-v2-shots.py 對模擬環境拍攝（隱私模式、
測試自選清單、擋掉所有下單與修改自選的請求）。

## 每次發版後更新 landing

發版（GitHub Release 發布）後開一張 docs 分支的 PR，合併到 main 才會上線。

1. **最新版本區塊**：index.html 的 `#releases`，改內建的版號、日期（datetime 一起改）、
   完整更新說明連結，清單放這版前五個 `###` 標題（去掉 issue 編號）。頁面會用 GitHub API
   讀最新版覆蓋，但 API 失敗或被限流時顯示的是這份內建內容。
2. **更新紀錄頁**：changelog.html 在 `data-chg` 最前面加一張新版本的卡片，列這版所有
   `###` 標題（「驗證範圍」除外）。
3. **值得展示的新功能段落**：只挑對新使用者有感的功能，加進或改寫既有段落
   （看盤下單、面板、版面等），寫「能幫你做什麼」，不逐條搬更新說明。修正類不上首頁。
4. **截圖隱私檢查**：沿用 RELEASE_NOTES 的示範截圖或另外拍，都要開隱私模式；
   每張逐一看過，帳號、持倉數量、損益、權益等金額都已遮蔽才可放。大圖轉 webp
   （寬圖做 1200／2400 兩種），加 width／height 與 alt。
   動態才看得出價值的功能（例如資金流向、持股族群）用約 4 秒的循環影片：深淺色各一支，
   H.264 mp4＋VP9 webm＋同名 -poster.webp，放進 `data-vt` 圖框；JS 依主題選檔、進入畫面才播放，
   「減少動態」時只顯示 poster。影片一樣要開隱私模式並逐格檢查。
5. **文案規則**：繁體中文；不寫 Claude Code、Codex 等 Agent 產品名稱，只講 Agent
   能幫你做什麼；提到下單或 Agent 時寫「每一筆下單都需要你的核可」；用「協助你交易」；
   不以「原生」「免費」「交易終端」當賣點；避免工程術語；顏色用既有主題變數；
   圖示只用 lucide，不用 emoji。
6. **驗證**：本機開 docs，桌面 1440px 與手機 375px、淺色與深色各看一次，
   確認沒有 console 錯誤、沒有水平捲動，PR 附截圖。
