// src/lib/apply-guide-config.ts — 首次設定「申請 API Key」導覽的唯一設定檔。
//
// 兩部分：
// 1. APPLY_PAGE_RULES：交給原生殼注入申請視窗（永豐官網）的步驟判斷規則與
//    要標示的按鈕／欄位。官網改版時只改這裡；找不到元素時網頁上不畫框，
//    App 側欄照樣顯示文字說明。格式由 Rust（apply_window.rs）驗證：
//    id 只能用小寫英數與 -，每條規則只能有 modalTitle 或 pathPrefix 其一。
// 2. APPLY_STEPS：側欄每一步的說明文字。
//
// 依據：2026-11-24 在正式官網實際走過的申請流程（Ant Design 元件）。

import { API_MANAGEMENT_URL, SIGNING_URLS } from './account-signing';

export const APPLY_URL = API_MANAGEMENT_URL;

/** 官網上偵測得到的步驟（順序即判斷優先序：先看開著的對話框，再看網址）。 */
export type ApplyPageStep = 'success' | 'form' | 'verify' | 'list' | 'login';

export interface ApplyStepRule { id: ApplyPageStep; modalTitle?: string; pathPrefix?: string }
export interface ApplyTarget {
    id: string;
    step: ApplyPageStep;
    selector?: string;
    // 實際要畫框的祖先元素（例如 antd 隱藏的 checkbox input → 外層 label）
    closest?: string;
    // 依按鈕文字找（忽略空白與大小寫，「確 定」＝「確定」）
    text?: string;
    // 進入該步驟時自動標示
    auto?: boolean;
}
export interface ApplyPageRules {
    modalSelector: string;
    modalTitleSelector: string;
    steps: ApplyStepRule[];
    targets: ApplyTarget[];
}

export const APPLY_PAGE_RULES: ApplyPageRules = {
    modalSelector: '.ant-modal',
    modalTitleSelector: '.ant-modal-title',
    steps: [
        { id: 'success', modalTitle: '新增成功' },
        { id: 'form', modalTitle: '新增 API KEY' },
        { id: 'verify', modalTitle: '身份驗證' },
        { id: 'list', pathPrefix: '/newweb/PythonAPIKey' },
        // 未登入時 API 管理頁會轉回首頁
        { id: 'login', pathPrefix: '/' },
    ],
    targets: [
        { id: 'login-button', step: 'login', text: '客戶登入', auto: true },
        { id: 'add-key', step: 'list', text: '新增 API Key', auto: true },
        { id: 'download-ca', step: 'list', text: '下載憑證' },
        { id: 'otp-method', step: 'verify', selector: 'input.ant-radio-input[value="mobile"]', closest: '.ant-radio-group' },
        { id: 'otp-target', step: 'verify', selector: '#applyOtp', closest: '.ant-select' },
        { id: 'send-otp', step: 'verify', selector: '.getOTPBtn', text: '發送驗證碼', auto: true },
        { id: 'otp-input', step: 'verify', selector: '#otpVal' },
        { id: 'confirm-otp', step: 'verify', text: '確認驗證' },
        { id: 'key-name', step: 'form', selector: '#apiKeyName', auto: true },
        { id: 'expire', step: 'form', selector: '#expireTime' },
        { id: 'perm-data', step: 'form', selector: 'input.ant-checkbox-input[value="Data"]', closest: 'label' },
        { id: 'perm-portfolio', step: 'form', selector: 'input.ant-checkbox-input[value="Portfolio"]', closest: 'label' },
        { id: 'perm-trade', step: 'form', selector: 'input.ant-checkbox-input[value="Trade"]', closest: 'label' },
        { id: 'perm-prod', step: 'form', selector: 'input.ant-checkbox-input[value="Prod"]', closest: 'label' },
        { id: 'accounts', step: 'form', selector: 'input.ant-checkbox-input[value*="accttype"]', closest: '.ant-checkbox-group, .ant-form-item' },
        { id: 'ip-mode', step: 'form', selector: 'input.ant-radio-input[value="1"]', closest: '.ant-radio-group' },
        { id: 'ip-value', step: 'form', selector: '#ipValue0' },
        { id: 'submit', step: 'form', text: '確定' },
        { id: 'secret-key', step: 'success', text: 'Secret Key' },
        { id: 'download-env', step: 'success', text: '下載 .env', auto: true },
    ],
};

// ── 側欄步驟 ─────────────────────────────────────────────────────────

/** 導覽的全部步驟：開始前、官網五步、App 載入、完成。 */
export type GuideStep = 'start' | 'login' | 'list' | 'verify' | 'form' | 'success' | 'imported';
export const GUIDE_ORDER: GuideStep[] = ['start', 'login', 'list', 'verify', 'form', 'success', 'imported'];

export interface GuidePoint {
    title: string;
    body: string;
    // 「在網頁上標示」的目標；沒有就不顯示按鈕
    target?: string;
    tone?: 'recommend' | 'caution';
    // 同一步內的小標題（表單分成幾組，一次看一組）；同組連續的點只在第一點顯示
    group?: string;
}

export interface GuideStepCopy {
    label: string; // 進度列上的短名稱
    title: string;
    lead: string;
    points: GuidePoint[];
    note?: string;
}

export const SUGGESTED_KEY_NAME = 'ShioajiPro';

export const GUIDE_COPY: Record<GuideStep, GuideStepCopy> = {
    start: {
        label: '開始',
        title: '申請你的 Shioaji API Key',
        lead: 'App 會在旁邊打開永豐金證券官網。這裡會一步一步告訴你要按哪裡。最後下載的金鑰檔（.env）會直接交給 App 保存。',
        points: [
            { title: '請先準備', body: '永豐金證券的網路登入帳號與密碼，以及開戶時留的手機號碼（會收到驗證碼）。' },
            { title: '先用模擬環境', body: '第一次申請的金鑰只用在模擬環境，不會動到真實的錢，所有功能都可以先試。' },
            { title: '帳號密碼不經過 App', body: '登入和驗證都在官網上完成。申請視窗關掉就會自動登出。' },
        ],
    },
    login: {
        label: '登入',
        title: '登入永豐金證券網站',
        lead: '在右邊的官網按「客戶登入」，用證券網路帳號和密碼登入。',
        points: [
            { title: '按「客戶登入」', body: '在官網右上角。按下後會跳出登入框。', target: 'login-button' },
            { title: '登入後回到 API 管理頁', body: '登入後如果還停在首頁，按下面的「回到 API 管理頁」。' },
        ],
    },
    list: {
        label: 'API 管理',
        title: '按「新增 API Key」',
        lead: '登入成功，這是 API 管理頁。按表格右上方的「新增 API Key」。',
        points: [
            { title: '按「新增 API Key」', body: '按下後會先確認是本人（身份驗證）。', target: 'add-key' },
            { title: '已有金鑰？', body: '舊金鑰的 Secret Key 已經看不到了，App 需要完整的金鑰，所以請新增一把。舊的可以留著。' },
        ],
    },
    verify: {
        label: '身份驗證',
        title: '收驗證碼完成身份驗證',
        lead: '官網會傳驗證碼到你開戶時留的手機號碼，照下面四個動作做。',
        points: [
            { title: '選「手機」', body: '再從下拉選單選你的手機號碼（中間幾碼會被遮住）。', target: 'otp-method' },
            { title: '按「發送驗證碼」', body: '按鈕會開始倒數。沒收到簡訊，等倒數結束再按一次。', target: 'send-otp' },
            { title: '輸入簡訊裡的數字', body: '填進「請輸入驗證碼」這一格。', target: 'otp-input' },
            { title: '按「確認驗證」', body: '看到「身份驗證成功！」後，會自動打開申請表單。', target: 'confirm-otp' },
        ],
    },
    form: {
        label: '填寫表單',
        title: '填寫「新增 API KEY」',
        lead: '每一欄都要填。照下面的建議填就好；找不到欄位時按「在網頁上標示」。',
        points: [
            { title: 'API Key 名稱', body: `最多 15 個字，只是方便辨認，例如「${SUGGESTED_KEY_NAME}」。App 會用這個名稱當作帳號名稱。`, target: 'key-name', group: '名稱與期限' },
            { title: '到期時間', body: '預設一年後。到期後金鑰失效，要重新申請；保留預設即可。', target: 'expire' },
            { title: 'API 權限：行情／資料', body: '看即時報價、K 線與歷史資料。Shioaji Pro 看盤需要，請勾選。', target: 'perm-data', tone: 'recommend', group: '勾選權限' },
            { title: 'API 權限：帳務', body: '查庫存、餘額、損益。請勾選。', target: 'perm-portfolio', tone: 'recommend' },
            { title: 'API 權限：交易', body: '下單、改單、刪單。模擬環境下單也需要，請勾選。', target: 'perm-trade', tone: 'recommend' },
            { title: 'API 權限：正式環境', body: '沒勾時，這把金鑰只能登入模擬環境（不動用真實資金）；勾了才能連正式環境下真實委託。建議第一次先不勾，熟悉後再另外申請正式用的金鑰。', target: 'perm-prod', tone: 'caution' },
            { title: '選擇帳戶', body: '勾選這把金鑰可以使用的帳戶：「證券」是台股現股、「期權」是期貨與選擇權、「海外」是複委託（美股）。只勾需要的帳戶。', target: 'accounts', group: '選擇帳戶' },
            { title: 'IP 地址權限：限制 IP（推薦）', body: '只有從填入的 IP 連線才能使用，金鑰外流也難被盜用。適合固定 IP（公司網路、固定制寬頻）。目前的 IP 可以在瀏覽器搜尋「我的 IP」查到；換網路（帶筆電外出、手機熱點）後要回來新增那組 IP，不然無法登入。可用「+ 新增另一組 IP」加多組。', target: 'ip-mode', tone: 'recommend', group: '連線限制（IP）' },
            { title: 'IP 地址權限：無限制 IP', body: '任何網路都能使用，適合浮動 IP 或常換網路。風險是金鑰外流就能被別人使用；只用模擬環境時影響較小，請妥善保管、不要分享 .env。', tone: 'caution' },
            { title: '按「確定」', body: '送出後會顯示「新增成功」。', target: 'submit', group: '送出' },
        ],
    },
    success: {
        label: '下載 .env',
        title: '按「下載 .env」交給 App',
        lead: '申請成功！按官網上的「下載 .env」，App 會自動收下並保存。',
        points: [
            { title: 'Secret Key 只會顯示這一次', body: '關掉官網的這個視窗後就看不到了。請等 App 顯示「金鑰已載入」再關。', target: 'secret-key', tone: 'caution' },
            { title: '按「下載 .env」', body: '檔案裡是金鑰名稱、API Key 與 Secret Key，不含 CA 憑證。', target: 'download-env' },
            { title: '「下載 QR Code」可以略過', body: '那是給手機 App 掃描用的。' },
        ],
    },
    imported: {
        label: '完成',
        title: '金鑰已載入',
        lead: '已經存成模擬帳號。按「啟動模擬環境」就可以開始使用。',
        points: [],
    },
};

/** 完成後的下一步：正式交易另外需要的條件（只說明，不在這裡辦理）。 */
export interface NextStepLink { label: string; url: string }
export interface NextStep { title: string; body: string; links: NextStepLink[] }
export const PRODUCTION_NEXT_STEPS: NextStep[] = [
    {
        title: '金鑰要有「正式環境」權限',
        body: '這把金鑰若沒勾「正式環境」，之後在 API 管理頁另外新增一把勾選的金鑰，再到帳號設定新增為正式帳號。',
        links: [{ label: 'API 管理頁', url: APPLY_URL }],
    },
    {
        title: '簽署 API 約定書',
        body: '依要交易的商品簽署對應的約定書。',
        links: [SIGNING_URLS.S, SIGNING_URLS.F],
    },
    {
        title: '完成模擬環境測試',
        body: '用模擬帳號登入並送出測試委託（Shioaji Pro 在模擬環境下單即可）；API 管理頁可以查看各帳戶的簽署與測試狀態。',
        links: [{ label: '查看狀態', url: APPLY_URL }],
    },
    {
        title: '下載 CA 憑證',
        body: '在 API 管理頁按「下載憑證」取得 Sinopac.pfx，再到帳號設定選擇憑證檔並輸入密碼。',
        links: [],
    },
];

export function nextGuideStep(step: GuideStep): GuideStep {
    return GUIDE_ORDER[Math.min(GUIDE_ORDER.indexOf(step) + 1, GUIDE_ORDER.length - 1)]!;
}
export function previousGuideStep(step: GuideStep): GuideStep {
    return GUIDE_ORDER[Math.max(GUIDE_ORDER.indexOf(step) - 1, 0)]!;
}
export function isApplyPageStep(value: unknown): value is ApplyPageStep {
    return typeof value === 'string' && APPLY_PAGE_RULES.steps.some(rule => rule.id === value);
}
