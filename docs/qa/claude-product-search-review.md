# Claude 商品搜尋審查交接

本機兩項最佳化及驗收已完成，指定的 Claude Opus 5.5 ultracode code review 尚未完成。阻擋是 OAuth 過期，沒有將其他 agent 的結果冒稱為 Claude 作答。

## 工具與登入狀態

- 使用者要求直接更新後，`claude update` 已將全域 Claude Code 由 2.1.119 更新至 2.1.302，`claude --version` 已核對。
- [官方模型設定](https://code.claude.com/docs/en/model-config) 區分 ultracode 與 effort；CLI 的 `--effort ultracode` 會啟用此模式並設定 xhigh。沒有把 max 或其他模型當作同一設定。
- 小型預檢以 `claude-opus-5-5`、`--effort ultracode`、唯讀 plan／restricted 模式執行；init 接受指定模型與旗標，工具限 Read／Glob／Grep，禁用 hooks 與外部 MCP。
- 預檢 exit 1，`is_error=true`，原文為 `Failed to authenticate: OAuth session expired and could not be refreshed`；`modelUsage` 為空。這不算模型審查成功。
- 尚未送出完整程式差異。預檢、原始輸出與 metadata 保留在本機 `work/claude-review/`，不提交憑證、設定或帳戶資料。

## 審查標準

1. 顯示正確：台積／台積電／2330 與 ETF 名稱／代號關聯相同，按 underlying_code 查詢，保留交易所、型別、target_code、日期與前綴歧義規則。月份先、一般／小型／微型後，期貨不被權證穿插；分段與最終結果一致。
2. 互動安全：只固定明確鍵盤／滑鼠選取，不把初始面板當成選取；中文組字、換字、關閉、卸載、選取及舊提交完成均不能污染新查詢。
3. 效能可證：檢查首批可選與完整補齊時間、重複 GET、排隊、最後讀者取消、共享者隔離、來源早敗清理與晚回快取。限制是四路有效 client 工作，不宣稱取消 daemon 內部作業。
4. 改善建議：提出可驗證情境、程式行號、實際成本與風險；區分既有已知限制、新回歸及尚未量測的假設。模型的每個有效發現都先轉成反例，再決定修正，不直接照單修改。

## 下一步行動

使用者自行執行 `claude auth login` 重新登入後，再執行小型預檢；確認指定模型有實際作答，才提交白名單 source／diff 做唯讀審查。不推送、不建立 GitHub PR、不下單。審查後更新此文件及 PR 草稿，保留原始答案與逐項複核。
