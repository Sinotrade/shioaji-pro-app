## v0.1.34 - Shioaji 1.7.1 市場脈動與盤中雷達

![市場脈動貢獻傳導](https://raw.githubusercontent.com/Sinotrade/shioaji-pro-app/v0.1.34/docs/images/market-pulse-flow.png)

### 市場脈動
- 新增上市、上櫃自算指數，並列顯示官方指數、價差、時間差、台指近月與期現差。
- 新增成分股貢獻、產業貢獻分布與貢獻傳導三種模組，可自由多選、並排及調整寬度。
- 貢獻傳導依點數比例呈現「指數方向 -> 產業 -> 主要個股」，並顯示個股代碼與名稱。
- 支援開盤前試撮資料與上市／上櫃雙市場預設版面；摘要列會依面板寬度自動換行。

![盤中雷達](https://raw.githubusercontent.com/Sinotrade/shioaji-pro-app/v0.1.34/docs/images/release-0.1.34-intraday-radar.png)

### 盤中雷達
- 新增盤中雷達預設版面，即時訊號可連動 K 線、五檔與成交明細，行情面板仍可個別鎖定。
- 新訊號會自動跟隨最新標的；商品解析完成後立即切換畫面，Tick／BidAsk 訂閱在背景接續完成。
- 漲跌停、急漲急跌、爆量與狀態訊號可個別啟用，並可篩選上市或上櫃市場。
- 訂閱狀態顯示實際規則與市場組合，不再把單一規則誤顯示成規則數量。

![訊號與市場篩選](https://raw.githubusercontent.com/Sinotrade/shioaji-pro-app/v0.1.34/docs/images/release-0.1.34-signal-filters.png)

### 串流與相容性
- 內建 Shioaji Server 升級至 `v1.7.1`，支援即時計算指數、個股與產業貢獻及市場訊號訂閱。
- Server 重啟、SSE 重連及每日維護後會自動恢復訂閱；市場訊號具備去重、保留上限與遺漏警示。
- 修正淺色主題貢獻傳導對比，深色、純黑與淺色主題皆可清楚辨識流向。

---

⚠ 回測結果基於歷史資料與簡化成本假設，不代表未來績效；AI 分析僅供參考；自動下單請自行評估風險，盈虧自負。

Shioaji Pro 桌面版 - 內建 shioaji server（sidecar）、伺服器管理介面、系統匣、自動更新。

下載：macOS `.dmg` | Windows `.msi` / `.exe` | Linux `.AppImage` / `.deb` / `.rpm`
