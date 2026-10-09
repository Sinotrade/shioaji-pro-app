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
