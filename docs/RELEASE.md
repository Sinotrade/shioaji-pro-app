# RELEASE.md — 發佈規範與流程（public repo）

## 原則

- **發佈只有一種**：對本 repo 的 main 打 `vX.Y.Z` tag。私有 repo
  （`shioaji-pro-desktop`）永不自行發版 — 它的變更由下一次 public tag
  自動收割（release CI 拉其 main HEAD）。
- **Tag 即版本**：版本號不存在任何檔案裡。release CI 從 tag 名解析
  版本並注入 `tauri.conf.json` 後才 build。repo 裡（含私有 repo）
  **沒有任何要 bump 的版本檔**。
- **順序：merge 先、tag 後**。release PR 經 review merge 進 main 之後，
  才對 main 上的 merge 結果打 tag — 出版的內容保證 review 過且在 main 上。
- **只需 public repo 的 write 權限即可完成發佈**，全程不碰私有 repo。
- GitHub release 標題固定 `Shioaji Pro vX.Y.Z`（CI 自動設定）。
  事後改內文用 `gh release edit vX.Y.Z --notes-file RELEASE_NOTES.md`，
  **絕不帶 `--title`**。

## 流程

### 1. 內容盤點（兩個 repo 都要看）

```bash
git log --oneline v<上一版>..HEAD                    # public 側變更
gh release download v<上一版> --pattern desktop-rev.txt -O -  # 上一版的私有 SHA
```

私有側變更 = 私有 repo `git log <desktop-rev 記錄的 SHA>..main`。
release notes 必須涵蓋兩邊的變更 — 純私有側的改動也構成一次合法發佈
（public 可以只有 notes commit）。

`desktop-rev.txt` 格式：行 1 `shioaji-pro-desktop@<short-sha>`（人讀），
行 2 完整 SHA（機器用）。**為什麼是 asset 不是 release body**：body 會被
tauri-action 與 publish job 兩度覆寫，放 body 必被洗掉 — 不要「優化」搬家。
**Bootstrap**：上一版早於此機制（≤ v0.1.43）沒有這個 asset — 首次改用
私有 repo 的 log 人工盤點起點，之後就有據可查。

### 2. 前置檢查

`tsc -b`、`vitest run`、`vite build` 全綠（release PR 的 CI 也會再跑一次）。

### 3. Release notes 與截圖

- `RELEASE_NOTES.md` 整檔改寫為新版本，首行 `## vX.Y.Z - 描述`
  （這行就是 release 內文標題）。
- 截圖存 `docs/images/release-X.Y.Z-*.png`（playwright、dark、zh-TW、
  privacy mode，clip 面板區域；盤中拍真資料最佳），內文引用 raw URL
  指向**新 tag**：
  `https://raw.githubusercontent.com/Sinotrade/shioaji-pro-app/vX.Y.Z/docs/images/...`
- 內文結尾照慣例附風險警語與下載說明段。

### 4. Release PR

```bash
git worktree add ../shioaji-pro-app.wt/release-vX.Y.Z -b release/vX.Y.Z
# commit RELEASE_NOTES.md + docs/images/*
git push origin release/vX.Y.Z
gh pr create --base main --head release/vX.Y.Z
```

CI 綠＋review 過 → `gh pr merge <N> --merge --delete-branch`。

### 5. 打 tag（＝按下發佈鈕）

```bash
git fetch origin && git merge --ff-only origin/main   # 主 checkout 同步
git tag vX.Y.Z && git push origin vX.Y.Z
```

Tag 觸發 `Release Desktop App` workflow：

- `create-release`：建 draft release、解析私有 repo main 的 SHA
  （之後四個 build 全部釘在這顆 SHA，不受 build 期間私有 main 變動影響）、
  上傳 `desktop-rev.txt`（內容 `shioaji-pro-desktop@<sha>`，追溯用）。
- `build` ×4（macOS arm64/x64、Windows、Linux）：拉私有 repo 指定 SHA、
  從 tag 注入版本、build＋簽章＋上傳。
- **Re-run 安全**：release 已帶 `desktop-rev.txt` 時，重跑會沿用第一輪
  記錄的私有 SHA（不重新解析）— 追溯與 assets 保持一致。
- `publish`：重建 `latest.json`、以 tag 上的 `RELEASE_NOTES.md` 套內文、
  去 draft 上線。

盯 CI：`gh run watch <run-id> --exit-status --interval 30`。

### 6. 驗證

- `gh release view vX.Y.Z --json isDraft,name,assets`：非 draft、標題
  `Shioaji Pro vX.Y.Z`、**18 個 assets**（v0.1.43 前為 17：dmg×2、msi、
  setup.exe、AppImage/deb/rpm、app.tar.gz×2 及各自 .sig、latest.json；
  新增 `desktop-rev.txt`）。
- `latest.json`（`releases/latest/download`）：version 正確、
  **11 個平台 key** 的 url 全指新版且 signature 齊。
- 抽驗 notes 內截圖 raw URL 回 200。

### 7. 收尾

- 相關 GitHub issue 回覆（引導更新＋說明修了什麼）並關閉。
- 內文事後要補改：`gh release edit vX.Y.Z --notes-file RELEASE_NOTES.md`
  （不帶 `--title`；GitHub API 偶發假 500，先 `gh release view` 確認
  是否已生效再重試）。

## 出錯復原

- tag 打錯／CI 失敗要重來：`gh release delete vX.Y.Z`、
  `git push origin :refs/tags/vX.Y.Z`，修正後重打 tag。
  **已上線（非 draft）的版本不刪** — 有問題直接出下一版。
