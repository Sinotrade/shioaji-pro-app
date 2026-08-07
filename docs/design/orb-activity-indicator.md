# Orb 活動指示器 — 技法筆記與使用準則

> 靈感來源：[aicss.dev/components/orbs](https://www.aicss.dev/components/orbs)（@kvnkld，agent UI 的
> thinking 狀態指示器集）。該站標榜 free to use 但**無明確授權條款**，故本專案
> 未複製其程式碼，而是依其核心手法從零實作 vanilla-extract 版本：
> [`src/components/orb.tsx`](../../src/components/orb.tsx) ＋
> [`src/components/orb.css.ts`](../../src/components/orb.css.ts)。

## 核心技法（值得反覆使用的部分）

一句話：**N×N 點陣 × 單一 keyframe × 負值 `animation-delay` 相位差 = 行進波**。

1. **所有點共用同一個 CSS 動畫**（`opacity`＋`scale` 的一次脈動）。差異只在
   `animation-delay` —— 把每顆點「播種」到週期的不同相位。
2. **負值 delay 是關鍵**：正值 delay 會讓動畫開場先靜止等待；負值讓每顆點
   從週期中段直接開跑，畫面第一幀就是連續波形，沒有暖場破綻。
3. **相位函數決定波形**，每個變體就是一條函數：
   - `radial`：`delay = -hypot(x-mid, y-mid) × k` → 波面從中心向外擴散
   - `comet`：沿外圈順時針索引 `delay = -(i/len) × period` → 一顆亮頭拖著衰減尾巴繞圈
   - （原站還有對角掃帶、亂序跳點等 —— 都只是換相位函數，零額外成本）
4. **只動 `transform`/`opacity`** → GPU 合成層、WKWebView 上極便宜，無 JS 逐幀。
5. 尺寸縮放：幾何用 `size/N` 推 pitch 與點徑，任何尺寸皆可（12–20px 甜蜜點）。
6. 顏色走 `currentColor`：由使用端文字色決定 —— 琥珀＝忙碌、繼承 muted＝一般
   載入，主題切換自動適配，元件本身零主題耦合。

## 本專案使用準則

- **用途**：「進行中」狀態 —— 載入、啟動中、（未來）AI Agent 思考中／工具執行中。
- **變體**：預設 `radial`（低調、專業）；`comet` 保留給有方向感的等待（如串流連線中）。
  原站較華麗的 G/C 系（光暈、漸層球）不符合本產品的專業終端調性，不引入。
- **搭配文字**：載入狀態一律「Orb＋說明文字」（`載入 TXO 合約…`），不做只有動畫
  的匿名等待 —— 使用者要知道在等什麼。
- **尺寸**：行內文字旁 10–12px、面板空狀態 12–14px、開機畫面 18–20px。

## 已套用位置（2026-08-07）

App 開機畫面（載入交易終端）、伺服器管理（啟動中／連線中，琥珀色）、K 線載入、
TXO 合約載入、類股熱力圖、歷史成交、權證市場、個股期、選擇權持倉、重播面板、
系統匣清單、面板庫即時預覽。

## 未來擴充

- AI Agent 面板 thinking／tool-running 狀態（private repo `modules/agent`）——
  同一元件，`comet` 變體＋accent 色是合理起點。
- 新增波形＝新增一條相位函數（見 `delayMs`），不需要動 CSS。
