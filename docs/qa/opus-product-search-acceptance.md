# Opus 商品搜尋 PM 審查與處置

> 以下保留各輪歷史。最新擴充版的完整驗收與效能預算見 [商品搜尋擴充驗收](product-search-expanded-acceptance.md)；a20 的接受不自動涵蓋後續變更。

## 2026-10-18 瀏覽器輸入量測複核

來源仍為 CPU 修正版 87 檔 `6666`。實際 Claude Opus 5.5 針對觀測器及提供的文字證據，依序完成 234.767 秒初審、128.212 秒文件收斂、60.379 秒最後核對；沒有使用工具、操作畫面或重算 raw。各輪原文保留，不改寫前輪發現為當時已通過。

初審 M1～M5 及後續 R1～R3 已收緊解讀或補齊來源、還原時點與命令證據。最後裁決接受 PR 文字與受控本機非退化 PASS，不宣稱瀏覽器加速；六組 p95 差為 −6.6～+1.3 ms，包含既有 debounce，完整排序一致。原始 1200 次正式樣本、240 次暖機與中途紀錄均保留。

最後對 QA 提出的 R1-b，源於題包節錄漏掉實際 HEAD／staged entries 斷言。Root 已補原始程式段、另有時間戳的後續 Git 核對與欄位映射，沒有宣稱這份補充又由 Claude 重審。詳細處置及三份原文連結見 [最新驗收](product-search-expanded-acceptance.md)。

僅接受 LOCAL DRAFT/DEV。真實 Tick／BidAsk 新鮮度、行情負載、原生 WebView／IME、production 及整份 PR 的整體效能仍未驗收；不是推送、合併或發布許可。先前 CPU／PR 作者與本輪 Root 事實補充各自標示，模型實際 effort 未回報。

2026-10-17，依使用者指定，以實際 Claude Opus 5.5 擔任主要 PM／架構與最後驗收；GPT-6.1 Sol 負責工程及獨立 QA，Gemini 3.8 經 AGY 提供前期 UI／UX 意見。僅本機草稿與 dev，不推送、建立 GitHub PR、合併、發布或下單。

## 實際模型與版本範圍

- Claude CLI `2.1.302`，固定 `claude-opus-5-5`。全新無資料 preflight 與下述成功審查，init、assistant 及 terminal model usage 一致，沒有以其他模型代替。
- 使用既有正常登入；沒有複製憑證、擴大權限或改全域設定。單次 CLI 設為 restricted／plan、空工具、空 MCP、停用 hooks／Chrome／session persistence，並監看事件。這不是 OS sandbox。
- `ultracode` 旗標與設定已接受，但 CLI 沒有回報實際 effort；不宣稱內部推理強度已驗證。
- 第一份 381088 bytes 完整題包於 300 秒截止，只有 init／thinking 事件，沒有完成答案或 terminal usage。保留紀錄，不計為成功 review。
- 第二份聚焦題包 159792 bytes，SHA-256 `81336d14ff77b142e3bfa457b37147fbb2776123ef589f82e796dfc7a3e80adc`，260.501 秒完成，SUCCESS／exit 0，工具／hook／權限事件 0。原文、題包及精簡事件保留在本機 `work/opus-pm-review/confirmation-*`。
- 第二輪檢視的是單行版 tree `5aba33364d40b6b9765bb6ff2c229a3617005f6f9f721452fd128ddbb19a30d8` 的指定程式與節錄，不是整個專案逐行審查。Opus 沒有操作畫面或執行測試。

## 第二輪 PM 裁決

Opus 對當時的本機草稿／DEV「有條件接受」，沒有提出 blocker 或 High，提出 6 項 Low。這不是正式發布、合併或推送核可，也不直接涵蓋後續使用者要求的半透明、跟隨自訂配色版本。

| 項目 | 工程複核與處置 |
| --- | --- |
| F1 股票色卡與選取列同底，邊框消失 | 已確認。後續依使用者要求改用主題 token 與 12% 淡底／45% 邊框，選取列跟隨 accentDim，另驗 normal／selected／hover 的實際合成對比及邊界差異 |
| F2 面板說明同時為 flex container 與 ellipsis，會硬裁切 | 已確認。改為 meta 外層及獨立文字內層，補結構與完整 title 回歸 |
| F3 空 detail 的 title 帶來重複朗讀風險 | 模型列假說。採最小預防修正：先計算去重後的 detail，空值不產生內層或空 title；有值保留原始完整提示。實際螢幕閱讀器未驗 |
| F4 幾何重算拉回使用者手動捲動 | 已修正並補正式回歸、獨立 work probe 5／5。模型「缺 contain」前提不成立，CSS 原本就有 contain，popup 自身 scroll 亦已忽略；真正問題是有效高度不變仍無條件 reveal。只在實際 clientHeight 改變或 hidden→visible 才 reveal；幾何持續 clamp |
| F5 清單隱藏時 Enter 仍提交看不到的商品 | 已修正並補正式回歸。原 hidden 中文 Enter 會送預設現股，hidden Arrow 能繞過弱 guard；現 action-time hidden 非純碼一律保留輸入、不提交。純碼仍可解析；目前同碼唯一且物件相同才保留 typed/full contract，後續 L1 再補同 query 舊 handler 防護 |
| F6 名稱來源故障時，2330選擇權只剩現股 | 已確認是 `4203ad5` 既有降級，非本輪回歸。current 與虛擬 baseline 各 4／4 邊界測試；先查過直接代碼 Info 也不會回填目錄名稱。列為未修 follow-up，不冒稱問題不存在或已解決 |

F4／F5 probe 的第一次執行曾把純碼 `onAdd('2330')` 誤期望為 3 個參數，只修正本機 probe 的斷言並保留報告；產品原路徑沒有失敗。正式程式及既有測試沒有為配合錯誤斷言而改寫。

## 架構與效能處置

Opus 確認身分／名稱 epoch 分離、共享目錄不占搜尋 slot、每讀者取消與有界 LRU／TTL 的責任分層合理；也確認名稱更新不會重抓有效的衍生商品，以及 Gemini B1 的快速代碼 Enter 主張已由反例否決。

保留已量測的資料，不另加正規化快取或廣泛訂閱抽象。固定 metadata 序列 14 GET 比基準 13 多出的 1 個是必要 IND gate，並行 2330 共用 2 GET；Node CPU 微基準不是瀏覽器或行情端到端數據。

F6 若另修，應考慮僅對該精確代碼做有截止、共享且帶型別的 Info 名稱補救，或由供應端提供 underlying 根對應。不遍抓全部 roots 或數百筆 Info，亦不將未知標的任意連到第一個商品。

## 最新版本驗收

使用者後續要求跟隨深／淺／任意自訂色及更透明淡底。第三份 UI delta 題包 62462 bytes，SHA-256 `0840a18c0508c16095466a62b5cc03f162938363d7e7a3346a5ca50392aa0fe3`，177.464 秒完成，init／assistant／terminal 均為實際 `claude-opus-5-5`，SUCCESS／exit 0、工具／MCP／事件 0。原文與 metadata 保留 `work/opus-pm-review/final-ui-*`。

該輪對 tree `044cb17be9219e9880d6d00554dbef63b40d3f22b0047c0304ade72128ce1e0c` 有條件接受 LOCAL DRAFT/DEV，無 Blocker／High；確認 F1–F5 的修正，保留 F6，另提出兩項 Low：

| 項目 | 最後處置 |
| --- | --- |
| L1 hidden 純碼同 code 異型別／交易所仍能選到不可見列 | 已先重現再修。只用 closure suggestions 做唯一性仍被同 query captured click 反例否定；改讀 currentSuggestionsRef，要求同碼唯一且為同一份當前 row 物件，其餘走 raw code。10 項新增回歸含重複、替換型別、同身分新 full contract、Enter／Plus 與唯一 typed 保留 |
| L2 六色數值相異不等於肉眼可分、邊界宣稱過度 | 已改測試名稱與說明為數值不等／分類以文字為準，去除重複斷言；不新增任意主題感知差保證，也不降低 4.5:1 文字標準 |

後續真正快速縮放又重現 RGL passive layout 回寫迴圈，取得 actual stack 與 StrictMode 先 RED 反例後才修 App adapter；不是把慢速 fixture 通過當作排除。當時 66 份來源 tree `6e0f877a8f20faf46d8dfd775cd497ef79d3f3029e9ca84987082196c3e2afbd`，完整 4010 PASS／0 FAIL／2 既有 native SKIP、build 通過、Sol 獨立 14 檔 401／401、實際主頁快速重放與 12 組查詢通過。該前版指標拖曳／縮放在隔離公開版面使用同一 production pure helper，面板掛載不增加，不改使用者版面。

第四份 closure 題包 113008 bytes，SHA-256 `d942cbec628e5802f637f6a28f9e95851d1bdc1cf521d09a7b201aac3830f7c2`，226.312 秒完成，SUCCESS／exit 0，init／assistant／terminal 均為實際 `claude-opus-5-5`、工具／MCP／權限事件 0。它對 tree 6e0f 有條件接受 LOCAL DRAFT/DEV，關閉 L1／L2、無 Blocker／High，明確保留 F6、既有跨密度手勢及全域 320 px grid 限制。該輪提出 N1 Low：測試重寫 App adapter 接線，單改 App 能繞過回歸；rapid 回寫斷言也過鬆。

N1 已改成 App 與 actual-RGL 正式測試共用 `useWorkspaceGrid`，單一密度公式及完整 handlers bag；另以 TypeScript AST 核對真正 App 接線。rapid 精確要求 0 回寫與至少 1 次拒絕；add／remove／profile／reset 精確為 0→1→2→3→3。工程及獨立 Sol QA 分別建立 production-module virtual mutation runner，guard、drag stop、resize stop、density 與 App spread 共 5 類均被測試攔下；前後 source SHA 相同。沒有以複製測試邏輯冒充連到 production。

使用者新附窄版截圖後，兩入口改按搜尋容器 ≤ 360 px 顯示名稱優先、代號其次，類別及 detail 先視覺隱藏，完整資料保留於 DOM 與單一列 title；寬版不變。此版共 67 份來源 tree `b858e730bc9ee273183846fa3d664232d9338e2ab225d611d9e3fc27832591da`，完整 4018 PASS／0 FAIL／2 既有 native SKIP，build、Node ETF 10／10 通過；獨立 Sol 14 檔 409／409 與 UI／badge／grid 3 檔 214／214（重疊不相加）。實際內建瀏覽器 255 px 自選、476.8 px 寬版、8 次快速切換及 12 組排序通過。

第五份 adapter-closure 題包 80323 bytes，SHA-256 `2d5e1517832b2df3ebb4f31c1329ba65bbf9a449174408893da5a1a2667ec13d`，229.853 秒完成，SUCCESS／exit 0，init／assistant／terminal 均為實際 `claude-opus-5-5`、空工具／MCP、禁止事件 0。它對 b858 有條件接受 LOCAL DRAFT/DEV、明確關閉 N1、無 Blocker／High 或新 must-fix；提出 N2／N3 兩項 Low，要求送 PR 前修正或揭露。root 均以實際畫面確認後交 Sol 補修：N2 是剛超過 360 px 時 meta 擠壓名稱，N3 是窄版面板命令的「＋」被商品名稱 order 移到後方。這不是把推論直接當成產品缺陷。

該包的窄版 UI test 節錄行數選錯、內容為空，Opus 明確未逐行核對那部分測試；CSS、JSX 與 actual browser 證據仍有提供，不能宣稱整份 UI test 都被模型審過。各輪只提供公開程式與精簡非敏感證據，沒有帳戶、訂單、環境設定或憑證；原文及精簡事件各自保留，不互相覆寫。

N2／N3 已完成最小修正：斷點維持 360 px，寬版名稱非零 10em basis、meta shrink 4，窄版仍名稱優先；面板命令改用獨立 panelIcon／panelName，不繼承商品欄位 order。正式測試同時鎖住 CSS 與 rendered DOM，真實 361.6／399.6／476.8 px 命令搜尋、361／400／255 px 自選與窄版委託簿命令通過。名稱寬度改善不等於所有文字皆完整顯示，metadata 的完整資訊仍依 DOM／列 title 保留。

最終 67 份來源 tree `a20face6b99d4a8cfb5255571018273f28fba1d12b2fbfda7ccc961cf473c622`，主控完整 251 檔、4019 PASS／0 FAIL／2 既有 native SKIP，build 與 Node ETF 10／10 通過；Sol 獨立 14 檔 410／410，另 UI／badge／grid 3 檔 215／215，覆蓋重疊不相加。除 4 份 UI 檔，其餘 63 份來源與 b858 逐 hash 相同，N1 的 production hook 及 5 類變異驗證不受改動。

第六份 ui-polish 題包 62449 bytes，SHA-256 `353692c455b139d59f6b54ff699d870838134205753407c5db391aa0f789d7ff`，提供完整 67 份 manifest、4 份 UI delta、正確 750–950 行測試節錄、theme token 及實際 before／after 證據。70.644 秒成功完成，SUCCESS／exit 0，init／assistant／terminal 均為實際 `claude-opus-5-5`、空工具／MCP、禁止事件 0。Opus 明確接受 a20 作為 LOCAL DRAFT/DEV，關閉 N2／N3、無新的必修；前輪 N1 已關閉。原文及 metadata 保留在本機 `work/opus-pm-review/ui-polish-*`。

最後裁決僅根據題包文字，未親跑測試、驗 hash 或看截圖，也未取得當時尚在定稿的 Sol 獨立 410／215 結論。root 與 Sol 另核對 63 份未變來源，但不寫成 Opus 親自核過。短名稱的空白、面板名稱與商品名稱字重差異屬可接受取捨；Watchlist 寬側 361–370 px 內容盒未直接取樣，只有命令搜尋 361.6 及自選 400 px 證據，不冒稱所有尺寸遍歷。meta 隱藏僅用於搜尋／加入自選／跳轉，不套用到下單畫面；鍵盤可見警示及原生報讀器仍未驗證。

延續條件：work／outputs 不進入 commit 或 build；PR 揭露既有 F6、跨密度手勢、全域 320 px grid、原生、夜盤及任意低對比主題限制。這是本機草稿驗收，不是 production／push／merge／release 核准。

第四輪也指出舊題包「10 項新增回歸全都先 RED」說法不精確，唯一 typed／Plus 情境原本已綠。本文及草稿只記 10 項新增案例，不宣稱每項都是先 RED，未刪測試或改低標準。

最新證據統一見 [最終 manifest](product-search-final-manifest.json) 與 [本輪驗收](product-search-remediation.md)。任意六色已透過實際 UI 套用並完整重載確認，不是假切換預設主題；216 組數學矩陣也不冒充所有任意配色或肉眼區分驗證。

原生 UI／HTTP allowlist、production CORS、2 項原生 bridge SKIP、正式登入、彈出視窗、乾淨機器、原生 IME／螢幕閱讀器、雲端 CI、新夜盤 Tick／BidAsk 均未因此通過。自選 320 px 的既有桌面 grid 寬度與 transform-only 拖動期間定位也仍有限制。

另保留既有 gesture 跨 density 回存風險：actual RGL 虛擬 probe 對 legacy 與 current 均重現拖曳中途換密度後寬 72→144，未宣稱已修。主控將此列 follow-up／正式發布 gate，最後 Opus 題包也明示該限制，不能將「快速非手勢 resize 的 feedback loop 通過」改寫成所有 stale writes 通過。

## 擴充版 317b 最後裁決

後續來源已擴充至 86 檔，tree `317bb5f57d66baec8b5b60334a871894371d2616a7977a9fbc527dab068b1007`。前段 a20 的「F6 未修」「窄窗不可用」「手勢密度未修」是當時狀態，後續修正與仍有限制的部分以 [最新擴充驗收](product-search-expanded-acceptance.md) 為準，不混用證據。

實際 `claude-opus-5-5` 依序完成 PM 計畫、動態資料計畫、效能裁決與最後擴充審查。最後題包 318413 bytes，SHA-256 `49eb986c961af15aa07482f8dbb791a9bf1656d47f16bbd6eb13224e328e128d`，526.184 秒成功，exit 0、init／assistant／terminal model usage 一致，空工具／MCP，禁止事件 0。`ultracode` 要求已接受，但實際 effort 未回報。它只看提供的來源、diff、測試與精簡證據，不親自執行測試、驗 hash 或查看像素。

裁決為「接受 LOCAL DRAFT/DEV，沒有新的 must-fix」，不是正式版本、原生、CI 或 SLA 核可。原效能 +10% 條件仍未通過，僅接受已揭露的 R1／R2 本機 CPU 預算；合併前仍需瀏覽器輸入延遲證據。原始回答見 [expanded answer](opus-product-search-expanded-answer.txt)。8 項低優先發現、哪些僅是假說、哪些已核對來源，以及暫緩理由，逐項記於最新擴充驗收。

獨立 Sol 最後跑過 263 檔，4197 PASS／0 FAIL／2 既有 native SKIP，Node ETF 10、型別、build、diff check 通過，前後來源與 HEAD／index 相同。Root 實際 build 預覽驗了 00981 字母尾碼優先、完整 009810、2330 前五筆、320／360 px 與兩入口標準 blur。Ponytail 只採用已讀取的審查指引，未安裝 plugin／hooks 或執行第三方腳本；原生、行情及其他 gate 不因它通過。

## 窄版代號在前的 f577 核對

使用者最新偏好取代先前名稱在前的要求。只移除兩份名稱 CSS 的 `order: -1` 並更新既有回歸，86 檔中 83 檔不變。新 tree `f577eab78c7ea29e540c3467b6a051d848fdb78bcfd6c7136b648892c6a8dd56` 的獨立全套仍為 4197 PASS／0 FAIL／2 既有 native SKIP，build 通過；實際 dev 與新 build 預覽兩入口代號在左、名稱在右，商品排序未變。

實際 `claude-opus-5-5` 另收到 11685 bytes 小題包，SHA-256 `06e97dd792c948866af1ef3d73311f574af5457f67e6759d65ef5cd86f861742`，36.683 秒成功、exit 0，空工具／MCP、禁止事件 0；effort 仍未回報。裁決為接受 LOCAL DRAFT/DEV、無 must-fix，並給出代號在前的 PR 修訂文字。原文見 [code-first answer](opus-product-search-code-first-answer.txt)。非阻擋觀察包括測試正則不是通用 CSS 解析器、自選只取樣 320 px、測試節錄未逐行提供兩個 parameterized 分支；不因此改寫成完整原生或所有尺寸驗收。


## CPU 修正版 6666 的最後裁決（2026-10-18）

使用者將效能限制改為最多慢 5%、目標更快，並指定實際 Claude 從事工程與最後審查。最後採用無跨搜尋快取的固定點快速路徑，完整商品、名稱、別名、排序及報價生產程式均保留。來源為 87 檔 tree `6666c4bb22786cde5e6179d8462f35bfa6649f3d73c7b2ef99b1b27b7239dab7`；相對 f577 只有 stock-index.ts、stock-index-search.test.ts 與新 stock-search-stream.test.ts。

實際 `claude-opus-5-5` 工程於 239810 ms 完成，題包 SHA-256 `2df9059b3d8c9a78255c61d5d8b72c22389b51fb2fd6db055b7eb5c808384559`。它提供 helper 與 6 項測試程式碼，Root 套用、修正型別接線、加入精確同分反例及排版，再由 Root／Sol 執行測試。先前減少重複工作的工程由 Sol 執行，不能把整個修正或測試執行都記成 Claude 親作。

最後聚焦審查於 218066 ms 成功，題包 SHA-256 `619502e639270e921b12903212e017a4c348d63005280a280167ce253efc4b71`，接受 LOCAL DRAFT/DEV、沒有 must-fix。只讀提供的核心程式、測試說明及精簡驗收文字，未親跑測試、驗 hash 或看像素，也不是重新逐行審查全部 87 檔。[原始回答](claude-product-search-cpu-review-answer.txt) 不改寫。

獨立 QA 為 4238 PASS／0 FAIL／2 項既有 native SKIP，Node ETF 10、tsc-b、Vite build、diff check 通過。Node 搜尋核心 10 查詢各自三輪平均 p95：暖搜尋對 f577 快 67.62%～71.39%，新目錄首次快 64.04%～69.48%，每查詢 5% 上限均通過；這不是 App 冷啟動、瀏覽器／IME 或真實報價延遲。42000 原始樣本與失敗／校正歷史保留，沒有把被拒 Map 或錯誤 VM-global harness 數字用作最終驗收。

本次 PR 說明另由實際 Claude 撰寫，105802 ms 成功，題包 SHA-256 `1463d95edca64ff7b99aa953460b05551cb6be6da4b95ba9034fe60b0ce5f8b0`，[原始回答](claude-product-search-cpu-pr-answer.txt) 保留。三次成功的 init、assistant、terminal model usage 均為指定模型，空工具／MCP、禁止事件 0；ultracode 旗標接受但實際 effort 沒有回報。

Root 實際 dev／新 build 命令面板排序通過，35 秒 SSE 只有 2 次 heartbeat，無真實 Tick／BidAsk，未完成週日以外夜盤驗證。原生精確候選、cookie 隔離、正式路由、乾淨 OS、雲端 CI、原生 IME／讀屏與既有 Low 待辦仍未通過。接受範圍僅本機草稿／dev，不推送、不建立 PR、不合併、不發版、不下單。
