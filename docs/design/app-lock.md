# 應用程式鎖（App Lock）

更新日期：2026-11-17（精簡版，取代 v2 的原生協定設計；v2 文件已移出 repo）。

應用程式鎖是**純前端的隱私遮罩**：離開座位時遮住 Shioaji Pro 的所有視窗、擋下手動操作，
券商連線、停損停利、觸價與背景監控照常執行。它只防旁人瞄到與誤觸，不能取代電腦的螢幕鎖定。

## 使用者決定

| 項目 | 決定 |
| --- | --- |
| 開關 | 設定 → 應用程式鎖，預設關閉。啟用時設定解鎖密碼：至少 6 個字元（以字元計），輸入兩次。修改密碼要目前的密碼；關閉要密碼。啟用後設定頁依序是：立即鎖定／修改解鎖密碼、密碼提示、睡眠時間、系統驗證。 |
| 密碼提示 | 選填，10 個字以內，在設定頁直接輸入、打字就存（輸入法組字中不存），不必輸入密碼。鎖定畫面按「密碼提示」才顯示，旁人也看得到。有設提示時，改完密碼提醒確認提示。 |
| 系統驗證 | 可選，預設關閉。Mac 接受 Touch ID 或 Mac 登入密碼，Windows 用 Windows Hello。開啟時先輸入解鎖密碼，再實際通過一次系統驗證。網頁版、或原生還沒有 `app_lock_system_auth` 時停用，顯示「這個版本還不能使用」。 |
| 上鎖入口 | 頂部列「螢幕鎖」膠囊（只在已啟用、沒鎖時出現；設定 → 頂欄顯示可以隱藏）；快捷鍵 ⇧⌘L／Ctrl+Shift+L（每個視窗都有效）；設定頁「立即鎖定」；電腦睡眠喚醒自動上鎖（睡多久才鎖在設定頁選：90 秒、5 分鐘、15 分鐘、30 分鐘、1 小時，預設 90 秒）。手動上鎖立即遮住。 |
| 重開 App | 鎖著時關掉，重開仍鎖著；沒鎖時重開不會上鎖。 |
| 解鎖 | 用解鎖密碼，或已開啟的系統驗證。成功後錯誤次數歸零；系統驗證取消或不能用不算輸錯。 |
| 錯誤次數 | 第 5 次：「解鎖密碼不正確。再錯 5 次將會登出。」第 8 次：「解鎖密碼不正確。再錯 2 次將會登出。」第 5 次起每次都提醒剩幾次。次數和鎖定狀態存在一起，重開不歸零。沒有等待時間、復原碼或停用。 |
| 第 10 次 | 完全登出，停損停利與背景監控會一起停（使用者已確認）。所有已儲存帳號的金鑰都清掉（不只使用中的那一組，否則登入畫面選另一組就進得去）。同時關閉應用程式鎖、清掉密碼與次數。登入畫面顯示「解鎖密碼連續錯 10 次，已登出。請重新輸入 API 金鑰登入；還沒有金鑰可到這裡申請」，連到 API 管理頁。網頁版沒有伺服器可停、登不出去，維持鎖住（清除網站資料才解得開）。 |
| 忘記密碼 | 鎖定畫面密碼欄下方「忘記密碼？」，按下去展開說明與「取消／確認登出並清除」，確認才登出。效果和第 10 次相同（同一條路：寫入 `failures: 10, forgot: true`）。登入畫面改顯示「已登出，並清除這台電腦的 API 金鑰。」網頁版顯示，確認後維持鎖住。旁人也按得到，效果等同亂打 10 次。 |
| 登出之後 | 登入畫面的說明後面加一句「應用程式鎖已關閉，登入後可到「設定 → 應用程式鎖」重新開啟。」 |
| 鎖定期間 | 遮住主視窗、popout、系統匣、核可視窗，以及掛在 body 的 portal 對話框；擋鍵盤、滑鼠、快捷鍵與拖曳。 |
| 鎖定畫面 | 標題、密碼欄；密碼欄下方一列，左邊「密碼提示」（有設才出現，按了換成提示內容）、右邊「忘記密碼？」；第 5 次起的提醒；解鎖鈕；有開系統驗證時多一顆系統解鎖鈕。頂部列同位置不再畫開關。 |
| 確認後被鎖 | 手動單按下確認後、送出前被鎖住：不送，回「應用程式已鎖定，這筆沒有送出」。自動單（停損停利、觸價）照送。 |

## 資料怎麼存

全部在前端的 localStorage，網頁版也能用。各視窗靠 `storage` 事件同步，寫法同 `src/lib/risk.ts`
（寫入的視窗自己通知自己）。

| key | 內容 |
| --- | --- |
| `sj-pro-app-lock` | 沒有＝未啟用。啟用後是 `{ salt, hash, iterations, locked, failures, system, wakeMs, hint, forgot }`。`wakeMs` 不是五個選項之一（含舊紀錄沒有這欄）時當成 90 秒；舊紀錄沒有 `hint`、`forgot` 時是空字串、`false`。 |
| `sj-pro-app-lock-logged-out` | 登出後寫入原因：`'1'` 錯滿 10 次、`'forgot'` 按了忘記密碼；登入畫面顯示一次說明後清掉。 |
| `sj-pro-app-lock-system-missing` | 原生沒有 `app_lock_system_auth` 時記下當時的 build；同一版不再試呼叫。 |
| `sj-pro-header-items` | 既有的頂欄顯示偏好，多一個 `screenLock`（缺省為顯示）。 |

- 密碼只存 PBKDF2-SHA256 雜湊：WebCrypto `crypto.subtle`、16 bytes 隨機 salt、600,000 次（OWASP 2023 建議值，WebKit 解鎖約 150 ms）、256 bits。
  次數跟著每筆紀錄存，舊紀錄照原次數驗證，改密碼時換成新次數。
  `iterations` 跟著雜湊存，之後要調高可以逐筆升級。
- 設定頁的密碼確認（修改、關閉、開啟系統驗證）不計入錯誤次數：沒鎖時本來就能操作 App。改睡眠門檻、關閉系統驗證不必輸入密碼，理由相同。
- 寫入時和存檔合併，鎖定與錯誤次數取比較嚴的那邊：別的視窗剛上鎖或剛輸錯（storage 事件還沒送到），或這個視窗
  之前寫不進存檔（記憶體鎖著、存檔沒鎖），都不會被蓋成沒鎖、次數變少。解鎖與歸零只能明確寫入。

## 程式結構

| 檔案 | 內容 |
| --- | --- |
| `src/lib/app-lock.ts` | 公開入口：re-export 公開 API（外部 import 路徑不變）、啟用／修改密碼／關閉、上鎖後的解鎖與忘記密碼、第 10 次登出、`initializeAppLock()`（裝攔截層、storage 監聽、開機登出重試、睡眠偵測）。 |
| `src/lib/app-lock-state.ts` | 型別、常數、狀態存取（`load`／`save`／`update`、emit 與訂閱、`useAppLock`、`isAppAccessBlocked`）、`lockApp`、小工具（`failureText`、`isMac`…）。模組內的 `state` 只在這個檔案。 |
| `src/lib/app-lock-fence.ts` | 攔截層（fence）：⇧⌘L、鎖著時吞掉遮蔽層外的事件、遮蔽層內只放行打字與編輯組合鍵、Tab 循環、焦點拉回。 |
| `src/lib/app-lock-crypto.ts` | PBKDF2：`hashed`（新密碼）、`verify`（驗證舊密碼）。 |
| `src/lib/app-lock-system-auth.ts` | Touch ID／Windows Hello：`systemAuth`、`systemAuthSupported`、原生沒有指令時依 build 記住。 |
| `src/lib/logout.ts` | 共用登出：伺服器管理的「登出」（只清使用中的帳號）與第 10 次輸錯（`allProfiles`，全部帳號）都走這裡。 |
| `src/components/app-lock-boundary.tsx` | 遮蔽層與鎖定畫面。核可視窗也載入，不引用 lucide-react 或 lib/trade。 |
| `src/components/app-lock-settings.tsx` | 設定 → 應用程式鎖。 |
| `src/components/screen-lock-switch.tsx` | 頂部列膠囊。 |
| `src/main.tsx`、`src/approval/main.tsx` | 最先呼叫 `initializeAppLock()`，再 render 包了 `<AppLockBoundary>` 的內容。popout 與系統匣也走 `main.tsx`。 |

各元件的守門（遮蔽層擋不到的縫）：

- `candle-chart`：拖曳改價到一半被鎖，線回原價，放開不改價。
- `flash-order`：拖曳移單到一半被鎖，放開不移單。
- `use-hotkeys`：鎖著時 Esc×2 全刪單、⌘K、B／S 都不動作，並清掉 Esc 的第一下。按鍵已經被攔截層擋在前面，
  這裡是第二層（Esc×2 全部刪單不能只靠一層）。
- 確認後、送出前再查一次是否已鎖（`isAppAccessBlocked()`）：`lib/trade.ts` 的手動單（`beforeDispatch`）
  與手動拆單（內層是 auto，確認後查）、下單匣與分倉（`order-ticket` 的 `beforeDispatch`）、手動鋪單
  （`grid-ticket` 的 `batch.beforeDispatch`）、整零價差點價與零股拆單（`odd-spread` 的 `beforeSend`）。
  動態跟隨補單、整零價差兩腳執行是自動的，不擋（中途擋下會讓兩腳失衡）。

手動「全平並取消」「再平倉」（`lib/conditional/flatten.ts`，全程 `source: 'auto'`）**沒有**守門：它只送刪單與平倉（降低風險），
動作是使用者自己確認的，旁人在鎖定期間觸發不了；確認後才被鎖時會跑完。和停損停利、觸價同一類的保護性動作。

拖曳可能在上鎖前就開始、委託可能在上鎖前就按下確認，攔截層擋不到，所以上面幾處要自己擋。按鍵不必：
遮蔽層內外的 keydown 都到攔截層為止，圖表與畫圖的快捷鍵收不到。

## 遮蔽層與攔截層

- **遮蔽層**：portal 到 body、不透明、z-index 10000。body 底下其他直接子元素加 `inert` 與
  `aria-hidden="true"`；鎖定期間新掛上的元素由 MutationObserver 補上；解鎖時放回原本的值
  （原本就 inert、`aria-hidden="false"` 的不會被改掉）。底層 App 全程保持掛載。
- **攔截層（fence）**：window 擷取階段第一個 listener（入口最先註冊）。鎖著時：
  - Escape 不論在哪都吞掉，並清掉 Esc×2 的第一下。
  - 遮蔽層外的鍵盤、滑鼠、右鍵、複製貼上、拖曳一律吞掉，焦點拉回遮蔽層。
  - 遮蔽層內只擋瀏覽器快捷鍵（⌘R、F5、⌘P…），留下編輯組合鍵（⌘⌫、⌘←／→ 這類整段刪除與游標移動只在焦點在密碼欄時放行：在按鈕上 ⌘←／→ 是上一頁／下一頁）與 AltGr 打字；右鍵一律吞掉（右鍵選單有「重新載入」），貼上用 ⌘V／Ctrl+V。
  - 遮蔽層內放行的按鍵只留預設行為（打字、Enter 送出、Tab），事件不再往下傳（`stopImmediatePropagation`）。
  - 沒鎖時只看 ⇧⌘L／Ctrl+Shift+L（按住不放只算一次），其他事件直接放行。
- **焦點**：上鎖時落在密碼欄（錯滿 10 次沒有密碼欄時落在遮蔽層本身，鎖定中錯到第 10 次也一樣）。Tab／Shift+Tab 由攔截層在遮蔽層裡循環：
  其他內容都 `inert`，只靠瀏覽器的話走到頭尾焦點會移出整份文件。焦點掉到遮蔽層外時（按鈕被移除…），攔截層把它拉回密碼欄；
  點到畫面的空白處也一樣給密碼欄（外框是 `tabIndex=-1`，焦點留在上面的話之後打的字沒有欄位接）。
  解鎖後不把焦點還給上鎖前的元素：按住 Enter 解鎖時，重複的按鍵會再觸發那顆按鈕。
- **睡眠偵測**：主視窗每 5 秒一次計時器，落差超過設定的門檻（預設 90 秒）就上鎖，做法同 `src/lib/stream.ts` 的
  `RESUME_GAP_MS`。最短的 90 秒也比背景節流（最慢約一分鐘一次）長；子視窗不偵測（系統匣平常隱藏、被節流）。

## 第 10 次輸錯（與忘記密碼）

按「忘記密碼？」確認後直接寫入 `failures: 10, forgot: true`，之後和第 10 次輸錯完全相同。


1. 寫入 `failures: 10`，畫面仍鎖著，改顯示「正在登出…」，正確密碼也解不開。
2. 主視窗呼叫 `logoutAndReload()`：`serverStop({ stopAgents: true, ownedOnly: true })` →
   `logoutCredentialProfile()` → 剩下的帳號逐一 `deleteCredentialProfile()` → `clearStoredSpawnKeyHash()` →
   清掉應用程式鎖、寫入登入畫面說明 →
   `window.location.reload()`。子視窗沒有憑證指令的權限，只寫下次數，由主視窗從 storage 事件
   （或下次啟動）接手。
   清鎖只改存檔、不通知畫面：這個視窗保持遮住，直到重新載入完成。其他視窗（popout、系統匣、
   核可視窗）收到鎖被清掉的 storage 事件時也不拆遮蔽，直接重新載入，丟掉登出前的畫面。
3. 伺服器停不下來、或有帳號刪不掉：鎖不清（fail-closed）。伺服器停不下來時 `logoutAndReload` 會重新載入。
   開機這條路同一個工作階段只自動試一次（輸錯第 10 次當下或開機時，先到的那次；記在 sessionStorage `sj-pro-app-lock-logout-tried`），
   避免無限重新載入。別的視窗寫入鎖定狀態（storage 事件）時仍會再試；重開 App 才重置。
4. 網頁版：沒有 `serverStop`，登不出去，維持鎖住（fail-closed），畫面提示清除網站資料。只清鎖不登出
   等於錯 10 次就解鎖。

## 原生要做的事

**必做：`app_lock_system_auth`**

- 沒有參數，回傳字串 `ok`／`cancelled`／`unavailable`；其他值或錯誤一律當成 `unavailable`。
- Mac：每次都用新的 `LAContext`，政策 `deviceOwnerAuthentication`（Touch ID 或 Mac 登入密碼），
  reuse duration 維持 0。Windows：Windows Hello（`UserConsentVerifier`），對話框掛在呼叫端視窗前景。
  Linux 回 `unavailable`。
- 系統對話框文字：「解開 Shioaji Pro」，不帶帳號或商品。
- 每個會顯示鎖定畫面的視窗（主視窗、popout、系統匣、核可視窗）都要允許呼叫。
- 前端不在掛載時試呼叫（會跳出系統驗證）。舊版原生回「Command app_lock_system_auth not found」時，
  前端停用這個選項，並依 build 記在 localStorage（`sj-pro-app-lock-system-missing`），同一版只試一次。

**選做：睡眠前就上鎖**

系統即將睡眠、螢幕鎖定、快速切換使用者時，對所有視窗發一個事件（建議名稱 `app-lock-lock`），
前端收到就呼叫 `lockApp()`。這樣睡不到門檻也會鎖，而且喚醒的第一個畫面就是遮住的。
前端的接收端等原生有了再加（一行 `listen`）。

## 已知限制

- 這是純前端的遮罩：任意 JavaScript、刪掉 localStorage、同一台電腦直接連 sidecar 都能繞過。
  只防旁人瞄到與誤觸；真正的安全靠作業系統的螢幕鎖定。
- 忘記解鎖密碼沒有復原方式：只能在鎖定畫面按「忘記密碼？」（或錯滿 10 次）登出，重新輸入 API 金鑰登入後再設定。
- 「忘記密碼？」不需要任何驗證，旁人按兩下就能登出（停損停利、觸價一起停）並清掉金鑰，效果等同亂打 10 次。
- 密碼提示以明文存在 localStorage，鎖定畫面上任何人按了都看得到。
- 睡眠偵測靠計時器落差：睡不到設定的門檻（最短 90 秒）不會鎖；主視窗長時間最小化而被系統暫停計時器時，回來可能
  被當成喚醒而上鎖（往安全的方向錯）。
- 焦點在 iframe 裡時收不到 ⇧⌘L。
- 原生視窗標題（例如 popout 的「⚡ 2330」）由原生設定，鎖定時仍看得到；要遮請原生在上鎖時改標題。
- 多個視窗同時試密碼時，storage 同步不是原子的，次數可能少算（每個視窗各試一次只記一次）。驗證期間別的視窗錯滿
  10 次時不會解開。要有單一的計數來源，得把計數與驗證移到原生（見原生建議 1）。
- 錯到第 10 次但伺服器一直停不下來（或憑證庫寫不進去）時，畫面停在「正在登出…」。重新載入後
  不會自動再試（只有別的視窗寫入時會），重開 App 才再試；鎖定畫面沒有「重試登出」鈕。

## 測試

行為測試，不比對 `.css.ts` 原始碼：

- `src/lib/app-lock.test.ts`：啟用與密碼長度、雜湊不是明文、四種上鎖入口、重開仍鎖、第 5／8 次
  提醒、第 10 次登出（主視窗、子視窗交給主視窗、登出失敗、網頁版）、跨視窗同步、系統驗證、fence。
- `src/lib/logout.test.ts`：共用登出的順序與停不下來的路徑。
- `src/components/app-lock-boundary.test.tsx`：inert 與精確還原、鎖定畫面、提醒、系統解鎖。
- `src/components/app-lock-settings.test.tsx`、`screen-lock-switch.test.tsx`、`onboarding-setup.test.tsx`。
- 守門：`candle-chart-order`、`flash-order-trigger`、`use-hotkeys`、`trade-exit`、
  `order-ticket-account`、`grid-ticket-account`、`odd-spread`。
- 接線：`src/main.test.ts`、`src/approval/main-lock.test.ts`。
