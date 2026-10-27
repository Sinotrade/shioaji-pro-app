# 商品搜尋（#327）

命令面板與自選新增共用 `src/lib/product-search.ts`。商品身分以券商有效合約為準，官方 ETF／一般股名稱只補名稱與別名，不產生券商不支援的商品。完整驗收紀錄放在 PR #327 附件，這裡只留最終結果與重現方式。

## 搜尋規則

| 輸入 | 結果 |
| --- | --- |
| `台積電`、`2330` | 現股 → 一般近月 → 小型近月 → 一般次月 → 小型次月 → 同前綴股票 → 權證 |
| `台指` | TXF／MXF／TMF 近月，再三種規格的次月；週契約排在月契約後 |
| `南亞` | 1303 → 南亞期近次月 → 2408 南亞科等同前綴股票 → 權證 |
| `2881` | 2881 → 期貨 → 2881A／B／C → 權證 |
| `櫃買`、`櫃買指數`、`IX0043` | 都找得到櫃買指數（OTC） |
| `00981` | 00981A／B／D／T 排在 009810 之前；完整代碼仍排第一 |
| `元大期` | 名稱完全相同的股票（6023），不當成「元大」的期貨查詢 |

- 期貨依規格分組，只列近月與次月：有 R1／R2 用連續月；缺 R2 用最早未覆蓋的實際月份；沒有 R 碼取最早兩個交割月。
- 顯示名稱以券商名稱為準，官方名稱只當別名（TPEx 公司簡稱不是交易簡稱）。
- 名稱來源只在 Vite dev／preview 的 `/metadata/*` 存在；沒有路由的環境（4xx、2xx 非 JSON）不再重試，原生版不啟用，改用內建快照與券商名稱。
- 命令面板分段顯示；自選只顯示最終結果。兩個入口的輸入框為 combobox，結果為只含 option 的 listbox。

## 重現

```bash
node node_modules/typescript/bin/tsc -b
node node_modules/vitest/vitest.mjs run src/lib/product-search src/lib/stock src/lib/etf src/lib/search-request src/components/product-search
node node_modules/vite/bin/vite.js build
# 更新 ETF 名稱快照（只在需要時；先看 diff 再 commit）
node scripts/refresh-etf-catalog.mjs --write
```

瀏覽器：`pnpm dev` 後在命令面板（Ctrl+K）與自選輸入框輸入上表的查詢。

## 2026-10-27 結果

- `tsc -b`、`vitest run`（5029 passed、2 skipped）、`vite build` 通過。
- dev（Vite 5198，`/api` 代理到本機 sidecar 21322，唯讀查詢）實測上表各查詢結果與規則一致；方向鍵移動時 `aria-activedescendant` 指向 listbox 內的 option；用 Esc 關命令面板不會出現「再按一次 Esc 全部刪單」，點面板內文字後再按 Esc 也一樣。自選浮層：Tab 進到詳情，浮層內 Esc 收起並回到輸入框，點外面收起後重新聚焦會恢復結果。
- 未驗證：浮層往下開只有單元測試（dev 版面上方空間足夠）；原生安裝包、讀屏軟體實機朗讀、正式網頁部署環境的 `/metadata` 路由。未送出委託，未修改自選清單成員。
