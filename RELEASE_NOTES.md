## v0.1.35 - 市場脈動資訊密度與瀏覽器連線修正

![市場脈動成分股與貢獻傳導](https://raw.githubusercontent.com/Sinotrade/shioaji-pro-app/v0.1.35/docs/images/release-0.1.35-market-pulse.png)

### 市場脈動
- 貢獻傳導新增「成分股／貢獻（點）／漲跌幅」欄位，漲跌幅可獨立開關並預設顯示。
- 成分股貢獻清單改為對齊的表格欄位，股票名稱會使用可用空間，不再過早截斷。
- 貢獻點數與漲跌幅統一靠右，單位集中於表頭，提升快速比較時的辨識度。
- 產業與方向節點保留點數單位；無法由 Top 25 明細拆出的貢獻仍以其餘成分股彙總呈現。

### 瀏覽器開發模式
- 修正多條 HTTP/1.1 SSE 長連線占滿同源連線池，導致 Contract V2 商品資訊 REST 請求延遲的問題。
- 開發模式將 REST 與 SSE 分散至兩個 loopback origin，仍共用同一個 Vite proxy 與 Shioaji Server。
- Tauri 桌面版維持既有直連方式，不受此項開發環境調整影響。

### 相容性
- 內建 Shioaji Server 維持 `v1.7.1`。
- 深色、純黑與淺色主題沿用市場脈動的方向色與表格對比設定。

---

⚠ 回測結果基於歷史資料與簡化成本假設，不代表未來績效；AI 分析僅供參考；自動下單請自行評估風險，盈虧自負。

Shioaji Pro 桌面版 - 內建 shioaji server（sidecar）、伺服器管理介面、系統匣、自動更新。

下載：macOS `.dmg` | Windows `.msi` / `.exe` | Linux `.AppImage` / `.deb` / `.rpm`
