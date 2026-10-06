# DEV.md — 開發規範與流程（public repo）

適用範圍：`Sinotrade/shioaji-pro-app`（開源前端＋release 基建）。
桌面閉源層（Tauri shell＋AI Agent）在私有 repo `shioaji-pro-desktop`，
該 repo 有自己的 `docs/DEV.md`，原則與本文件一致。

## 治理原則

1. **main 永不直接 push** — 由 `main-protect` ruleset 硬性強制。
   所有變更（含文件、發佈 notes）一律走 PR。
2. **main 永遠是綠的、永遠可發佈** — 任何時刻都可能對 main 打 tag 出版
   （見 [RELEASE.md](RELEASE.md)），merge 進 main 等同宣告「可出貨」。
3. **PR 合進 main 一律 merge commit（`--merge`）** — 禁 squash merge／
   rebase merge。保留功能分支 commit SHA 是發佈追溯與 tag 祖先關係的
   前提；開發分支同步 main 的 rebase 規則見下節。

## 分支與 worktree

- 分支命名：`feat/<slug>`、`fix/<slug>`、`refactor/<slug>`、
  `docs/<slug>`、`chore/<slug>`；發佈分支固定 `release/vX.Y.Z`。
- **所有開發都在 worktree 裡做**，主 checkout 的 main 永遠保持乾淨、
  只用 `git fetch` ＋ `git merge --ff-only origin/main` 同步：

  ```bash
  git worktree add ../shioaji-pro-app.wt/<slug> -b feat/<slug>
  # …開發、commit、push、開 PR…
  git worktree remove ../shioaji-pro-app.wt/<slug>   # merge 後清理
  ```

  agent 開發使用內建 worktree 機制，效果等同。

### 開發分支同步 main

- 尚未推送、只有單一開發者使用、且未被其他 repo／分支以 SHA 引用的
  短期開發分支，應定期同步最新 main：

  ```bash
  git fetch origin
  git rebase origin/main
  ```

- 分支一旦已推送共享、開啟 PR／進入 review，或被跨 repo pin 指向，
  就必須保留既有 SHA，改用 `git merge origin/main` 同步；不得 force-push
  重寫已共享歷史。
- PR 最終仍以 merge commit 合進 main；開發分支曾 rebase 不改變這項規則。

## PR 與 review

merge 的前提，缺一不可：

1. **CI 綠** — `ci.yml`（PR 觸發：`tsc -b`＋`vitest run`＋`vite build`）
   已設為 ruleset 的 required status check，不綠 GitHub 不給 merge。
2. **Review 過**：
   - 維護者本人／agent 的 PR：至少一輪 AI review（`/code-review` 或
     等效 agent review），CONFIRMED 等級的發現必須修掉或明確記錄
     won't-fix；功能型變更照慣例過 QA agent 驗收後才進 PR。
     滿足後允許 self-merge。
   - 外部貢獻者的 PR：CI 綠＋維護者 review 核可。

### 未來 review 規範（規劃中，尚未生效）

Review 標準將逐步擴充：Gherkin 驗收測試、mutation testing、
test coverage 門檻、quality metrics 等。落地時更新本節。

## Commit 慣例

- Conventional commits：`feat(scope): 描述`／`fix(...)`／`docs(...)`／
  `chore(...)`／`refactor(...)`，內文中文、寫清楚動機與行為變化。
- Agent 產出的 commit 附 `Co-Authored-By`。

## 品質基線

- 型別檢查用 `tsc -b`（不是 `--noEmit`，對 project references 那是空檢查）。
- 單元測試 `vitest run` 必須全綠；wire 相容性（server 事件格式）變更
  必須附真實 payload 的回歸測試。
- 詞彙表在根目錄 [CONTEXT.md](../CONTEXT.md)；重大架構決策記
  [docs/adr/](adr/)。設計文件在 [docs/design/](design/)。

## 與私有 repo 的關係

- 發佈時 CI 以唯讀 deploy key 拉取私有 repo（`modules/`＋`src-tauri/`）
  疊進本 repo 完成桌面 build — 本 repo 的開發與發佈**不需要**私有
  repo 權限。
- 私有 repo 的 PR 會透過 `repository_dispatch` 觸發本 repo 的
  `desktop-ci.yml` 做合成驗證（詳見私有 repo 的 DEV.md）。

### Desktop Agent CI 觸發與驗收

- `desktop-agent-ci.yml` 在指向 main 的 PR 開啟／更新時跑 Linux/Windows
  合成測試；push 只監聽 main，避免開發分支同一個 commit 同時觸發 push
  與 PR 兩輪，互相取消後在 PR 留下紅叉。
- 尚未開 PR 的分支若要合成驗證，使用 `workflow_dispatch` 手動選擇分支。
- concurrency 依 workflow、事件與 PR 編號／ref 分組。新 commit 可取消
  同 PR 的舊 run，但手動執行、main push 與其他 PR 不互相取消。
- 步驟定義在 reusable workflow `desktop-agent-build.yml`。外部 fork PR 拿不到
  secrets，`combined-agent` 會 skip（fork-notice 寫 summary）；維護者 review
  並對目前 head 送出 Approve review 後加 `run-desktop-ci` label（gate 驗證
  加 label 者為 write+ 且其 APPROVED review 綁定該 SHA），由 `desktop-agent-ci-fork.yml`
  （`pull_request_target`）對加 label 當下的 head SHA 跑同一套步驟，結果以
  commit status `desktop-agent-ci (maintainer-approved)` 回報；新 push 自動
  移除 label。安全設計與殘餘風險見 [CONTRIBUTING.md](../CONTRIBUTING.md)。
- 回報 CI 完成前，核對最新 PR head 的完整 check rollup；若仍有 failed、
  cancelled 或 pending，不得只挑成功的 run 宣告全綠。取消原因與重跑結果
  須寫回 PR，等待所有檢查完成後再交付。

### 公私 paired PR 的 merge 順序

同一功能同時修改 public/private 時，兩個 PR 必須先以
`DESKTOP_MODULES_REF` 的 immutable private SHA 完成合成 CI、review 與 QA，
再依下列順序落地：

1. private PR **用 merge commit** 合進 private `main`，禁止 squash/rebase
   merge，並暫停任何 `v*` tag。
2. 取得 private `origin/main` 新的 merge-commit SHA，把本 repo PR 的
   `DESKTOP_MODULES_REF` 更新到該 SHA，重跑 public Linux/Windows composite
   CI，確認 release overlay 可由 private main 重現。
3. public PR 用 merge commit 合進 public `main`。兩邊 main 都落地且 CI
   綠後，才允許進入 [RELEASE.md](RELEASE.md) 的 tag 發佈流程。

不得先 merge public、不得讓 release workflow 的 private-main HEAD 與
`DESKTOP_MODULES_REF` 指向不同實作，也不得在 paired PR 僅落地一側時打 tag。

## Dev／候選版的版本識別

- App 畫面與複製診斷統一使用 build identity。`vite dev`、未帶 release tag
  的 `vite build`、本機 debug bundle 都顯示 `dev · <public short SHA>`；
  build／dev server 啟動時有未提交內容則加 `+dirty`，無 Git metadata 顯示
  `dev · unknown`。commit 後重新啟動 Vite 才會更新這份 build-time identity。
- Tauri／Cargo／package.json 的占位版本不能當成候選版版本對外顯示；
  不得為了畫面好看而手動 bump 成預計發布的版本。候選版說明可寫預計版本，
  但它仍是未發布的 dev build。
- 正式 release build 只從 GitHub tag context（`GITHUB_REF_TYPE=tag`、
  `GITHUB_REF_NAME=vX.Y.Z`）顯示 `vX.Y.Z`，與 native bundle 的 tag 注入一致。
- 交付 dev App 給人驗收前，確認伺服器面板、Debug、頁首與複製診斷均顯示
  相同 build identity，並分開核對 sidecar 的 `SHIOAJI_VERSION`。不得把舊
  Tauri 占位值（例如 0.1.43）誤認為當前 App build。
- 自訂 Vite port 時也要驗證原生 WebView SSE 的 Origin；sidecar 預設接受
  `5173` 的 dev origin。其他 port 使用 Vite 同來源 `/api` proxy，設定
  `VITE_STREAM_BASE` 為 dev origin，`VITE_API_TARGET` 為本次 sidecar origin；
  健康檢查與歷史資料正常不能代替 SSE 的 LIVE／heartbeat 驗證。

## 每次開發交付：備妥可試用的 dev App

- 同機已有正式 sidecar 時，隔離 dev App 設定 `VITE_DEV_SERVER_PORT=21323`。
  此設定只在 development 生效，將原生服務管理、REST 與直接 SSE 鎖定到指定埠；
  不可因 `21323` 停機或占用而探測、接手或啟動到 `21322`、`8080` 或其他 fallback 埠。
  舊 localStorage 的正式服務埠／PID 不能成為隔離 dev 的操作目標。
- `VITE_API_BASE` 通常不另設；若設定，必須與隔離服務的 scheme、`127.0.0.1`
  及 `21323` 完全一致，矛盾設定會拒絕連線。自訂 Vite port 時，SSE 使用
  `VITE_STREAM_BASE` 指向目前 Vite 的同來源 origin，並將 `VITE_API_TARGET`
  設為 `http://127.0.0.1:21323`（HTTPS 服務則使用相符 scheme），讓 `/api` proxy
  指向同一隔離 sidecar。不可把 SSE override 指向正式 `21322`；同源 proxy 的
  target 亦須人工核對，不能只看到 REST 正常便宣稱隔離或 SSE LIVE 通過。
- 隔離啟動前後分別確認 dev 與正式 App／sidecar 的 PID、port、模式和新 heartbeat；
  僅清理由本次任務建立的程序。原生管理與 SSE 的實測證據、mock 探測測試分開記錄。

- 每次完成功能或修正，都要把 dev App 更新到本次工作分支，實際開啟並
  驗證可操作後再交付；只有 PR、CI 或隔離 browser fixture 不算完成 dev 交付。
- 純前端變更沿用相容的原生 dev shell，切換其 Vite 到本次 worktree；
  private/native 有變更時須用精確 pin 重建相容的 dev App。主 checkout
  保持乾淨，不為了試用 merge 或發布。
- 更新前辨識 dev App、Vite、sidecar 的實際 PID／port／模式。保留使用者
  的正式 App、交易伺服器與其他工作；不使用真實下單作驗證。若必要操作
  會影響活躍策略或 Agent，先說明具體影響，依既有授權判斷是否需確認。
- 更新後核對畫面 build identity、sidecar 版本、SSE LIVE／新 heartbeat、
  主要變更面板及錯誤狀態；回報實際驗證範圍，不把模擬／CI 當成原生
  登入、真實回報或乾淨機器 QA。
- 交付時提供 App 名稱、build identity 與啟動方式，保留供使用者實測的
  dev App／Vite 及其 worktree。關閉額外的隔離 QA 程序；使用者結束實測
  或已切換替代版本後，再清理已合併且乾淨、沒有程序依賴的 worktree。

## DEV 限定：首次登入精靈（帳號密碼登入）

沒有 API Key 時，開發環境的首次登入畫面多一個「帳號密碼登入」分頁，用本機
Chrome 代為完成永豐金證券的 API Key 申請（設計與限制見
[ADR 0008](adr/0008-sinopac-onboarding-dev-wizard.md)）。

- 啟動：`pnpm dev`，瀏覽器開 `/?setup=1`（`?setup` 只在 dev 生效，用來在
  一般瀏覽器預覽首次登入畫面）；或使用 Tauri dev shell。
- 需要本機安裝 Google Chrome。找不到時以 `SINOPAC_CHROME_PATH` 指定執行檔
  路徑；`SINOPAC_HEADLESS=0` 會顯示瀏覽器視窗（預設 headless）。
- Tauri dev shell 尚未驗證；目前只在瀏覽器 dev 模式實測過。
- 申請成功後金鑰寫入專案根目錄 `.env`：原子寫入（先寫暫存檔再 rename），每次寫入後權限收緊為 0600（既有檔案也會）。OTP 一律由本人輸入。
- 即時畫面：精靈開始操作官網後，視窗右下角會出現一顆圓形按鈕（預設收合），點開就能看本機 Chrome 此刻在官網上做什麼；機器人正在操作時圖示有藍點。面板左上角的把手可以調整大小（拖曳、點一下切換大小、方向鍵微調），按 Esc 或再按一次按鈕收合。畫面是 MJPEG 串流（`GET /api/sinopac-onboarding/live`），收合就斷線、伺服器停止擷圖；同時只留一位觀看者。
  - 進入「建立金鑰」後一律不給畫面（伺服器與前端兩邊都擋）：官網的成功視窗會直接顯示 Secret Key。
  - 畫面是官網的原樣截圖，**含未遮罩的身分證字號、手機、Email、帳號與機器人輸入的內容**，不經 `masking.ts`；只限本機同源頁面讀取。分享螢幕或錄影前請先收合。
  - 端點要求 `Sec-Fetch-Site: same-origin` 或 `none`，直接用 `curl` 要加 `-H 'Sec-Fetch-Site: none'`。
- production build 不含此功能：分頁以 `import.meta.env.DEV` 判斷，後端是
  Vite dev-server middleware，`vite build` 不掛載它，bundle 內沒有精靈
  （plugin 模組在載入 Vite 設定時仍會被評估，但不含瀏覽器自動化程式）。
- 這會對真實的永豐金證券網站操作；開發測試請用 `scripts/sinopac-onboarding/`
  內的 fake-site 單元測試，不要用真實帳密反覆試。
