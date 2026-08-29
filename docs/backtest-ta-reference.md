# 回測 / 自訂指標 `ta` 函式庫參考

> 自訂指標與回測策略共用同一套腳本環境：**純 JavaScript ＋ `ta.*` 序列函式庫**。
> 本文件對應實作：
> [`src/lib/ta.ts`](../src/lib/ta.ts)（函式庫本體）、
> [`src/lib/custom-runtime.ts`](../src/lib/custom-runtime.ts)（自訂指標執行環境）、
> 回測策略執行環境與引擎（閉源 backtest 模組：`strategy-runtime.ts`、`backtest.ts`）。

## 腳本環境

使用者程式碼以 `new Function` 編譯，`"use strict"` 下執行，開頭自動解構出
下列變數 —— 直接當全域用即可，不用 `import`：

| 變數 | 型別 | 說明 |
|---|---|---|
| `open` `high` `low` `close` `volume` | `number[]` | K 棒序列，與 K 棒逐根對齊（`volume` 股票為張、期貨為口） |
| `time` | `number[]` | 每根 K 棒時間（Unix 秒） |
| `hl2` `hlc3` `ohlc4` | `number[]` | 常用複合價：`(H+L)/2`、`(H+L+C)/3`、`(O+H+L+C)/4` |
| `bars` | 物件 | 上述序列的原始容器 `{time, open, high, low, close, volume}` |
| `p` | 物件 | 參數表定義的參數，`p.參數代號` 取值 |
| `ta` | 命名空間 | 下方所有序列函式 |

兩種腳本的**輸出函式**不同：

- **自訂指標**（K 線圖 → 指標 → 自訂）：
  - `plot('名稱', 序列, opts?)` — 輸出一條線。`opts`：
    `{ kind: 'line' | 'dashed' | 'histogram' | 'points', color: '#rrggbb', signed: true, width: 2 }`
  - `hline(數值)` — 副圖參考水平線（如 RSI 的 30/70）
  - 至少要呼叫一次 `plot()`
- **回測策略**（策略回測面板）：
  - `longEntry(序列)` `longExit(序列)` `shortEntry(序列)` `shortExit(序列)`
  - 序列該根的值 `> 0`（或 `true`）代表訊號在**該根收盤**成立
  - 至少要有進場訊號；只有進場沒有出場（也沒有反向翻單）會被驗證擋下

### 序列與缺值慣例

所有 `ta.*` 函式吃序列（陣列）回傳序列，長度與輸入相同、逐根對齊。
暖身期（前 n−1 根）與缺值以 `null` 表示並向下傳染；圖上自動留白，
回測訊號的 `null` 視同 0（不觸發）。回傳型別為 `(number | null)[]`。

## `ta` 函式總表

以下是 `ta` 命名空間**實際存在的全部函式**（`src/lib/ta.ts` 的具名匯出）。
`src` 為序列；`n` 為週期（自動取整）；`a` `b` 可為序列或常數。

### 均線 / 平滑

| 函式 | 參數 | 回傳 | 說明 |
|---|---|---|---|
| `ta.sma(src, n)` | 序列, 週期 | 序列 | 簡單移動平均 |
| `ta.ema(src, n)` | 序列, 週期 | 序列 | 指數移動平均（α = 2/(n+1)，以首個完整窗均值起算） |
| `ta.wma(src, n)` | 序列, 週期 | 序列 | 線性加權移動平均 |
| `ta.rma(src, n)` | 序列, 週期 | 序列 | Wilder 平滑（α = 1/n；RSI/ATR/DMI 系列用的平滑） |

### 統計 / 極值

| 函式 | 參數 | 回傳 | 說明 |
|---|---|---|---|
| `ta.stdev(src, n)` | 序列, 週期 | 序列 | 滾動標準差（母體） |
| `ta.highest(src, n)` | 序列, 週期 | 序列 | 近 n 根最高值（**含當根**） |
| `ta.lowest(src, n)` | 序列, 週期 | 序列 | 近 n 根最低值（**含當根**） |
| `ta.sum(src, n)` | 序列, 週期 | 序列 | 滾動加總 |

### 動能 / 波幅

| 函式 | 參數 | 回傳 | 說明 |
|---|---|---|---|
| `ta.change(src, n = 1)` | 序列, 期數 | 序列 | `src[i] − src[i−n]` |
| `ta.roc(src, n)` | 序列, 期數 | 序列 | n 期變動百分比（×100） |
| `ta.rsi(src, n)` | 序列, 週期 | 序列 | RSI 0–100（Wilder 平滑） |
| `ta.tr(high, low, close)` | 三條序列 | 序列 | True Range（用前收計算跳空） |
| `ta.atr(high, low, close, n)` | 三條序列, 週期 | 序列 | ATR = `rma(tr, n)` |

### 逐根運算（序列或常數混用）

| 函式 | 說明 |
|---|---|
| `ta.add(a, b)` `ta.sub(a, b)` `ta.mul(a, b)` `ta.div(a, b)` | 加減乘除（除以 0 → `null`） |
| `ta.max(a, b)` `ta.min(a, b)` `ta.avg(a, b)` | 逐根取大 / 取小 / 平均 |
| `ta.abs(src)` | 逐根絕對值 |

### 其他

| 函式 | 參數 | 回傳 | 說明 |
|---|---|---|---|
| `ta.offset(src, n)` | 序列, 期數 | 序列 | **往回取 n 期前的值**：`out[i] = src[i−n]`（延遲 / ref） |
| `ta.cum(src)` | 序列 | 序列 | 累積和（自己組 OBV 這類指標用） |
| `ta.crossover(a, b)` | 序列/常數 ×2 | 序列 | a 上穿 b 的那根 = 1，其餘 0（b 可為水平常數） |
| `ta.crossunder(a, b)` | 序列/常數 ×2 | 序列 | a 下穿 b 的那根 = 1，其餘 0 |
| `ta.toSer(src)` | 陣列 | 序列 | 把任意陣列正規化成序列（非數值 → `null`；一般用不到） |

以上就是全部 —— `ta` 沒有其他隱藏函式。腳本是完整的 JavaScript，
上表組不出來的邏輯（遞迴型、條件累加型指標）直接寫 `for` 迴圈即可。

## 內建 21 種技術指標與 `ta` 的關係

內建指標（[`src/lib/indicator-defs.ts`](../src/lib/indicator-defs.ts)）另外實作在
[`src/lib/indicators.ts`](../src/lib/indicators.ts)，**不能**用
`ta.macd()`、`ta.boll()` 這種方式直接呼叫。`ta` 提供的是「積木」，
對應關係如下：

| 內建指標 | `ta` 對應 |
|---|---|
| MA / EMA / WMA | 直接呼叫：`ta.sma` / `ta.ema` / `ta.wma` |
| RSI | 直接呼叫：`ta.rsi(close, n)` |
| ROC | 直接呼叫：`ta.roc(close, n)` |
| ATR | 直接呼叫：`ta.atr(high, low, close, n)` |
| BOLL | 兩行組合：`ta.sma` ± 倍數 × `ta.stdev` |
| Donchian | 兩行組合：`ta.highest(high, n)` / `ta.lowest(low, n)` |
| Keltner | 組合：`ta.ema` ± 倍數 × `ta.atr` |
| MACD | 組合：`ta.sub(ta.ema(close,12), ta.ema(close,26))`，訊號線再 `ta.ema(dif, 9)` |
| KD / StochRSI / W%R | 組合：RSV 用 `ta.highest` / `ta.lowest` 算，再平滑 |
| BIAS | 組合：`ta.div(ta.sub(close, ma), ma)` × 100 |
| OBV | 組合：`ta.cum` ＋依 `ta.change(close)` 正負給量 |
| CCI / MFI / DMI(ADX) / VWAP / SAR / SuperTrend | `ta` 積木不夠（需條件累加、逐日錨定或遞迴狀態），要自己寫 JS 迴圈 |

## 延遲與突破進場

- **引擎內建一根延遲，無未來函數**：訊號在第 i 根**收盤**成立 →
  第 i+1 根**開盤價**成交（含設定的滑價；最後一根強制以收盤平倉；
  反向進場訊號會自動先平倉再翻單）。所以策略程式碼裡「用當根收盤判斷」
  是安全的，成交本來就在下一根。
- **腳本內要參考前幾根**：用 `ta.offset(src, n)`。
  例如 `ta.offset(close, 1)` 就是前一根收盤。
- `ta.highest` / `ta.lowest` **含當根**。做「突破前 N 根高點」時要先
  `ta.offset(..., 1)` 排除當根，否則收盤永遠 ≤ 含自己的最高價，
  `crossover` 不會觸發。

### 範例：突破 20 根高點進場、跌破 10 根低點出場

參數表定義 `len`（預設 20）、`exitLen`（預設 10）後，策略程式碼：

```js
// 前 N 根高低點（offset 1 = 不含當根）
const hh = ta.offset(ta.highest(high, p.len), 1)
const ll = ta.offset(ta.lowest(low, p.exitLen), 1)

// 收盤突破前 20 根高點 → 隔根開盤做多
longEntry(ta.crossover(close, hh))
// 收盤跌破前 10 根低點 → 隔根開盤平倉
longExit(ta.crossunder(close, ll))

// 想做空就反過來：
// shortEntry(ta.crossunder(close, ll))
// shortExit(ta.crossover(close, hh))
```

## 常見問題

**回測圖上怎麼看成交量？**
回測 K 線圖沒有內建成交量副圖，但它與主圖共用同一份指標設定
（含自訂指標）。建一個副圖自訂指標：

```js
plot('VOL', volume, { kind: 'histogram' })
```

加到圖表指標後，在回測結果的進出場圖開啟「顯示主圖指標」，
成交量柱狀就會出現在副圖。量的衍生線（如量均）同理：
`plot('VOL MA', ta.sma(volume, 20))`。策略裡也可以直接拿 `volume`
運算，例如爆量過濾：`ta.crossover(volume, ta.mul(ta.sma(volume, 20), 2))`。

**暖身期會影響回測嗎？**
會自然跳過 —— 暖身期輸出為 `null`，`null` 訊號不觸發進出場。

**寫錯或無窮迴圈會怎樣？**
儲存前在 Web Worker 驗證（2 秒逾時），錯誤訊息會直接顯示在編輯器。
