# ADR 0008: DEV 限定的永豐金證券首次登入精靈(帳號密碼登入)

日期:2026-10-05
狀態:提議中(開發分支 `feat/sinopac-onboarding`,見 PR #242,尚未合併;須維護者明確接受下列「後果」中的條款風險才能採納)

## 背景

首次使用者通常還沒有 API Key。上游的首次登入畫面(`src/components/onboarding-setup.tsx`)只接受貼上 API Key 與 Secret Key,或匯入 `.env`;沒有 Key 的人必須自己到永豐金證券官網完成登入、憑證(TWCA)、OTP、權限設定與 Key 申請,再回來貼上。這段流程步驟多、容易中途放棄,是首次上手的最大斷點。

## 決策

在 **DEV 環境**提供第二個「帳號密碼登入」分頁,由本機驅動真實的永豐金證券官網,代使用者完成 API Key 申請,並把金鑰寫入專案 `.env`。

- 後端是 Vite dev-server 的 middleware(`scripts/vite-plugin-sinopac-onboarding.ts` 在 `configureServer` 掛載,邏輯在 `scripts/sinopac-onboarding/`),透過 Puppeteer 控制本機已安裝的 Chrome。`vite build` 不掛載它:plugin 設 `apply: 'serve'`,且 `puppeteer-core` 只在 `devDependencies`。plugin 模組本身仍會在載入 Vite 設定時被評估,但不含瀏覽器自動化程式。service 與 driver 以動態 import 延後到第一個精靈請求才載入,`puppeteer-core` 則延後到第一次啟動 Chrome 才載入。
- 前端分頁以 `import.meta.env.DEV` 判斷顯示;production 的畫面與行為和上游一致,仍只有 API Key 登入。與上游相比,主 chunk 只多了不影響行為的程式碼(+185 B),CSS 與其他 chunk 逐位元組相同。
- 前端與後端的契約型別放在 `src/lib/sinopac-onboarding/types.ts`,錯誤碼為 `ONBOARDING_*`。

## 運作方式

步驟(畫面上的 `FlowStepper`):**帳密 › 生日 › 憑證 › 權限 › 金鑰 › 完成**。內部狀態為 `login`、`birthday`、`cert_otp`、`terms`、`relogin`、`plan`、`key_otp`、`creating`、`done`、`stopped`。已有可用憑證的帳號不會經過生日與憑證兩步,畫面標為「略過」。

- **一個流程一個 BrowserContext**:`gateway.ts` 維持一顆長駐 Chrome,每個申請流程各開一個隔離的 BrowserContext;service 同一時間只允許一個流程,新流程開始前會先關掉殘留的 context。閒置與總時限逾時後關閉。
- **OTP 一律由使用者本人輸入**:系統只負責按「寄送」,收碼管道以遮罩形式顯示,驗證碼不由任何自動化取得。OTP 錯誤即停止整個流程,不重試。
- **憑證作業條款(TWCA)**:第一步登入畫面有勾選框,使用者須先勾選「我已閱讀並同意憑證作業條款」(重新登入不需再勾);進入條款步驟後前端才自動送出 `accepted: true`,後端才在永豐金證券頁面勾選條款並按確定。自動同意須同時滿足兩個條件:這次流程已在第一步取得使用者勾選同意,且頁面上的條款與登入畫面顯示的全文完全一致(不得多出任何條款);任一不成立就顯示手動條款畫面,由使用者本人按下同意。路由要求 `accepted` 必須為 `true`。自動同意失敗時同樣退回手動按鈕。
- **金鑰存檔**:Key 建立後在同一個請求內寫入專案根目錄 `.env`(`SJ_API_KEY`、`SJ_SEC_KEY`)。已有 `.env` 只替換這兩行;檔案不存在才新建。一律先寫暫存檔再 rename(原子寫入),完成後權限設為 `0600`(既有檔案也會收緊)。寫入前後暫停 Vite 的 `.env` 監看,避免 server 重啟與頁面重載,延遲約 1 秒後恢復。
- **Secret 只在存檔失敗時顯示一次**:永豐金證券只在成功視窗顯示 Secret 一次,所以存檔失敗時回 `ONBOARDING_KEY_CAPTURE_FAILED`,並把金鑰放進錯誤本體讓使用者自行複製(存檔失敗時不論 `revealSecret` 一律回傳,因為這是唯一還拿得到 Secret 的時機);存檔成功時僅在 `revealSecret` 為 true(桌面版)才回傳。伺服器不保留這份回應。建立金鑰的請求只送一次,中斷後不重送,避免建出第二組 Key。
- **開通**:完成畫面會確認帳戶是否已開通 API 下單(`src/lib/sinopac-onboarding/readiness.ts`);未開通則列出簽署與模擬測試的引導。

## 安全邊界

以下是從程式碼確認的:

- 路由(`routes.ts`)只處理 `/api/sinopac-onboarding/*`,一律在該層結束,不會被 `/api` proxy 轉給 sidecar;所有 POST 必須是 JSON Content-Type(作為 CSRF 防線,跨站簡單請求不能帶),本文上限 16 KB,欄位 key 集合須與契約完全相同。
- 帳號密碼只經過請求本文,不寫進 log、不進 repository 狀態;log 只記錄錯誤碼、所在步驟與 driver 附上的固定診斷,不記錄原始錯誤、頁面文字或任何輸入。用戶端看到的文案一律是固定中文,不轉述伺服器或網頁原文。憑證流程用完的帳密只放前端記憶體,離開流程即清掉。
- 登入最多 2 次(`MAX_LOGINS`),在請求被 claim 時就先記帳,中途中斷也不會有第 3 次;任何失敗都不自動重試,避免帳戶被鎖定。
- 不繞過 reCAPTCHA:頁面要求勾選檢核框時回 `ONBOARDING_RECAPTCHA_CHALLENGE` 並停止,請使用者改到官網手動申請。網站結構與預期不同時回 `ONBOARDING_SITE_CHANGED`,停止且不再做任何操作(安全失敗)。
- 原生對話方塊只代按 alert 與離開頁面確認;confirm、prompt 一律取消。
- 本機限定檢查:`routes.ts` 要求 `Host` 為本機回送位址(`localhost`、`127.0.0.1`、`[::1]`)、請求的遠端位址為本機,且帶 `Origin` 的請求須與 `Host` 同源,否則回 403 `ONBOARDING_FORBIDDEN_ORIGIN`;沒帶 `Origin` 的請求(同源 GET、非瀏覽器)放行。
- 導覽網域白名單:`gateway.ts` 對每個新分頁開啟請求攔截,只中止頂層 document 導向到 `sinotrade.com.tw`、`sinopac.com`、`sinopac.com.tw`、`spf.com.tw`、`twca.com.tw`(含子網域)以外的網址;iframe 與子資源不擋。尚未對真實網站驗證(UNVERIFIED)。
- CDP 走 pipe(`launchOptions()` 設 `pipe: true`),不開本機 TCP 除錯埠。
- 依賴 `puppeteer-core`(不下載 Chromium),以 `channel: "chrome"` 或 `SINOPAC_CHROME_PATH` 使用本機 Chrome。

## 考慮過但不採用

- **只提供手動引導**:把官網步驟寫成清單讓使用者自己做。零風險,但就是目前造成斷點的狀態;精靈失敗時仍保留這條路(停止畫面的「在永豐金證券官網自己完成」引導)。
- **由雲端伺服器代為操作**:在遠端主機上跑瀏覽器代操作。不採用,因為使用者的身分證字號、密碼與 OTP 會經過第三方伺服器;改為完全在本機瀏覽器內執行,金鑰直接寫進本機 `.env`,不經過任何外部服務。

## 後果

- **只有 DEV 可用**。要讓正式版使用者也能用,需把這套自動化(Chrome 控制與金鑰存檔)封裝進 Tauri shell(私有 repo),本 ADR 不涵蓋;`.env` 寫入位置也屬 Vite dev server 的 `process.cwd()`,在 Tauri 要另行決定。
- 使用者需要本機安裝 Google Chrome(`SINOPAC_CHROME_PATH` 可指定路徑)。
- 永豐金證券網站改版會讓流程安全地停止(`ONBOARDING_SITE_CHANGED`),但選擇器與文字比對仍需要人跟著維護。部分行為仍標記為 `UNVERIFIED`(例如 OTP 錯誤後頁面是否允許重輸、達 30 組 Key 上限時的畫面),尚未觀察過。
- **條款風險(維護者須明確接受)**:以自動化操作永豐金證券網站,是否符合其網站使用條款,本專案**沒有**取得券商的書面許可或確認。帳號被鎖定、被判定為異常登入,或券商要求停止,都是可能後果。此功能代使用者勾選憑證作業條款,雖然有使用者先行同意的畫面與路由限制,但同意的法律效力與券商是否接受代為操作,同樣未經確認。
- **真實帳號驗證**:2026-10-05 在瀏覽器 dev 模式用真實帳號完整手動跑過兩次,第二次是在套用 review 修正之後;兩次的條款都在全文完全一致後自動同意。自動化測試仍使用 `fake-site.ts` 模擬頁面。
- 未驗證項目:Tauri dev shell 內的行為;production 可用性;OTP 錯誤後的頁面行為與 30 組 Key 上限畫面(同上)。
