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
