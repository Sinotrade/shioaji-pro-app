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
3. **相位函數決定波形**，每個變體就是一條函數（lattice/ring 家族）。
4. **路徑點＝CSS 自訂屬性**（globe/morph 家族）：keyframe 寫成
   `transform: translate(var(--g3x), var(--g3y))`，每個點用 inline style 傳入
   自己的路徑點座標 —— 一條靜態 keyframe 就能讓 40 顆點各走各的 3D 軌跡，
   不需動態注入 keyframes。這是本次移植最值得記住的一招。
5. **只動 `transform`/`opacity`/`filter`** → GPU 合成層、WKWebView 上極便宜，無 JS 逐幀。
6. 尺寸縮放：幾何全部由 `size` 推導，任何尺寸皆可（10–20px 甜蜜點，展示可放大）。
7. 顏色走 `currentColor`：由使用端文字色決定 —— 琥珀＝忙碌、繼承 muted＝一般
   載入，主題切換自動適配，元件本身零主題耦合。

## 變體總表（五大家族，全數已移植）

| 家族 | 變體 | 視覺 | 語意傾向 |
|---|---|---|---|
| lattice 3×3 | `radial`（預設） | 波面自中心擴散 | 泛用載入，無方向性 |
| | `band` | 對角掃帶 | 掃描/處理中 |
| | `comet` | 亮頭繞外圈 | 輪詢/進行中 |
| | `sweep` | 直欄左→右 | 逐步處理 |
| | `shuffle` | 亂序跳點 | 隨機工作 |
| ring 8點 | `ring` | 亮頭順時針繞圈 | 經典 loading，銜接舊 spinner 語彙 |
| | `ringAlt` | 奇偶交替閃 | 心跳/待命 |
| | `ringShuffle` | 亂序繞圈 | — |
| globe | `globe` | 3D 點球儀旋轉（40 點） | 「全域思考」，品牌感最強 |
| focus | `focus` | 四圓焦點巡迴＋blur 景深 | 柔和的「注意力轉移」，AI 感 |
| morph | `morph` | 8 點圓→八角→方→菱形變形（4.8s） | 長任務/塑形中 |

## 本專案使用準則（風格裁決）

- **泛用載入＝`radial`**：低調、對稱、無方向性，最符合專業終端調性 —— 全 app 預設。
- **伺服器啟動中／連線中＝`ring`**：旋轉語彙銜接被取代的舊弧形 spinner，
  「有東西在跑」的方向感明確（已套用，琥珀色）。
- **AI Agent thinking（未來）＝`globe`**：品牌記憶點最強、僅單實例場景使用
  （40 顆點的 DOM，別放進清單列）。reasoning 細分狀態可用 `focus`。
- **長任務（如回測執行中）＝`morph`**：4.8 秒週期的從容感適合分鐘級等待。
- band/sweep/shuffle/ringAlt/ringShuffle 為庫存變體，非必要不啟用 —— 同一畫面
  同時出現兩種以上波形會互相搶戲。
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
