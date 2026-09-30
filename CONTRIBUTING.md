# 貢獻指南 / Contributing

歡迎提交 issue 與 PR！提交 PR 即表示你同意以 AGPL-3.0 授權你的貢獻，
並同意維護者可將其納入雙授權（dual-licensed）發行版本（見 [README](README.md#license)）。

開發環境、commit 慣例與品質基線請見 [docs/DEV.md](docs/DEV.md)。

## 外部 fork PR 的 CI 流程

本 repo 的桌面版（Tauri、AI Agent 等）需要疊入**私有模組**才能完整 build，
CI 以唯讀 deploy key 拉取。GitHub 不會把 secrets 提供給 fork PR，
而且把私有金鑰交給未經審查的程式碼並不安全，所以 fork PR 的 CI 分兩段：

| 檢查 | fork PR 何時執行 | 是否 merge 必要 |
| --- | --- | --- |
| `CI / checks`（tsc＋vitest＋vite build） | 自動（首次貢獻者需維護者按一次 Approve and run） | **是** |
| `web-build`（不含私有模組的開源 build） | 自動 | 否 |
| `desktop-agent-ci / combined-agent` | 顯示 **skipped**（不是失敗），summary 會說明原因 | 否 |
| `desktop-agent-ci-fork`＋status `desktop-agent-ci (maintainer-approved)` | 維護者 review、Approve 目前 head 後加上 `run-desktop-ci` label 才執行 | 否（維護者判斷） |

1. 你開 PR 後，公開檢查會照常跑；請先讓 `CI / checks` 綠燈。
2. 維護者**逐行 review** 你的變更、對目前 head 送出 Approve review 後，
   加上 `run-desktop-ci` label，對「加 label 當下的 commit」跑完整 desktop CI
   （Linux／Windows），結果以 commit status 出現在 PR 的 checks。
3. 之後你每 push 一次新 commit，label 都會**自動移除**，需要維護者重新
   review、Approve 新 head 再加一次。這是刻意的：避免 review 後被換成未審查
   的程式碼。已在執行中的舊 commit build 不會因新 push 取消，但它的結果只
   掛在那個舊 commit 上，不代表新 head 通過。

你不需要、也不會拿到私有模組的存取權；純前端／web 的修改在本機
`pnpm build && pnpm test` 即可完整驗證。

### 給維護者：加 label 前務必確認

`run-desktop-ci` 會讓 PR 的程式碼（`package.json` scripts、依賴、測試、
`build.rs` 等）在**私有模組已在磁碟上、deploy key 仍在 runner 記憶體中**的
環境執行。惡意 PR 有能力外流私有原始碼或 deploy key，這是「用私有模組測
外部程式碼」本質上無法消除的風險。所以：

1. 完整 review diff，特別注意 `package.json`／`pnpm-lock.yaml`、
   新依賴、`build.rs`、測試檔、任何網路存取與 `.github/` 變更。
2. 對**目前的 head commit** 送出 **Approve** review（PR 頁 Files changed →
   Review changes → Approve）。
3. 再加上 `run-desktop-ci` label。

workflow 會先檢查（不執行 PR 程式碼）：加 label 的人必須有 write／maintain／
admin 權限（Triage 或 bot 不行），且此人對「加 label 當下的 head SHA」最新
一筆有效 review 是 APPROVED。任一不符 → label 自動移除、head SHA 上出現
failure status、job summary 說明原因。這把核准綁到你實際 review 過的
commit：若你 review 完 A、對方在你加 label 前推了 B，B 沒有你的 Approve，
不會執行。

- label 只代表核准**當下那個 commit**；新 push 會自動撤銷（若撤銷 API 失敗，
  `revoke-approval` job 會紅燈並要求手動移除）。
- 若曾對可疑 PR 加過 label，請輪換 `AGENT_SSH_KEY` deploy key。

已做的防護：workflow／overlay action／私有 SHA pin 一律取自 `main`（PR 改不到）；
checkout 不保留 credentials；SSH key 只存在 overlay 那一個 step（刪檔不是
機密隔離邊界，runner 記憶體仍有 secret）；build job 的 `GITHUB_TOKEN` 只有
`contents: read`；untrusted 模式不使用 pnpm cache。依 GitHub 現行規則，
`pull_request_target` 等低信任觸發對 default branch scope 的 cache 只有唯讀，
無法寫入被 `release.yml` 讀取的 main cache（見 [Dependency caching — cache
access for low-trust workflow triggers](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching#cache-access-for-low-trust-workflow-triggers)）。
`actions/checkout` 在 `pull_request_target` 下預設拒絕 checkout fork 程式碼，
只有 fork 路徑在上述檢查通過後才以 `allow-unsafe-pr-checkout: true` 開啟。

---

## English summary

- Fork PRs run the public checks automatically: `CI / checks` (the only required
  check) and `web-build`.
- The private desktop CI (`combined-agent`) is **skipped** on fork PRs because it
  needs a read-only deploy key for the private desktop modules. A job summary
  explains this.
- After reviewing the code, a maintainer submits an **Approve** review on the
  current head and then adds the **`run-desktop-ci`** label. A
  `pull_request_target` workflow first verifies (without running PR code) that the
  labeler has write/maintain/admin permission and an APPROVED review whose
  `commit_id` equals the head SHA at label time; otherwise it removes the label and
  posts a failure status. If the gate passes, it builds that exact SHA with the
  private overlay and reports the commit status `desktop-agent-ci (maintainer-approved)`.
- Any new push removes the label automatically; re-review, re-approve and re-label to
  run again. An already-approved build of an older SHA is not cancelled by a new
  push; its result only applies to that older SHA.
- `pull_request_target` has read-only access to default-branch caches, so the
  fork path cannot poison caches used by `release.yml`.
- Residual risk (maintainers): the PR's code runs with the private modules on disk
  and the deploy key in runner memory, so a malicious PR could exfiltrate them.
  Review before labeling; rotate the deploy key if a suspicious PR was ever labeled.
