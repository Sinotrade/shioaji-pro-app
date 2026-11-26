// 申請視窗注入腳本（私有 overlay 的 src-tauri/src/apply_window_guide.js）
// 用這裡真正的 APPLY_PAGE_RULES 跑在仿官網結構的 HTML 上。
// 只有疊上私有 overlay（desktop CI／本機合成）時才有這支腳本，否則略過。
//
// 簽署頁 fixture 依 2026-11-26 公開頁面（未登入的 SSR HTML 與頁面程式）：
// 條款是 antd Checkbox（label.ant-checkbox-wrapper.signCenter_paragraphTitle__…）、
// 「下載【…】」是 span.signCenter_red__btn__l__…、下載後才出現 h5 裡的確認勾選框、
// 登入後才有的帳戶表格（antd Table，簽署與否欄位「已簽署／未簽署／審核中」）、
// 「簽 署」是 button.signCenter_sign__btn__…。登入後的實際畫面要以 debug 結構摘要校正。

import fs from 'node:fs';
import path from 'node:path';
import { Window } from 'happy-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { APPLY_PAGE_RULES, guideCardOf } from './apply-guide-config';

const SCRIPT = path.resolve(__dirname, '../../src-tauri/src/apply_window_guide.js');
const hasScript = fs.existsSync(SCRIPT);
const MARK = ' ⁣sjpro-step:';
const DOM_MARK = ' ⁣sjpro-dom:';
const NAV_MARK = ' ⁣sjpro-nav:';
/** 原生殼每次開窗產生的 nonce（測試用固定值） */
const CARD_KEY = '0123456789abcdef0123456789abcdef';

interface Box { left: number; top: number; width: number; height: number }
interface LoadOptions {
    /** 元素的位置（沒給的元素都當成左上角 10×10） */
    rect?: (el: Element) => Box | null;
    viewport?: { width: number; height: number };
    /** 注入前改 window（例如包住內建函式） */
    before?: (win: Window) => void;
}

const clause = (n: number, checked = false) =>
    `<p class="signCenter_paragraph__3GyNM"><label class="ant-checkbox-wrapper${checked ? ' ant-checkbox-wrapper-checked' : ''} signCenter_paragraphTitle__318AX">`
    + `<span class="ant-checkbox"><input type="checkbox" class="ant-checkbox-input"${checked ? ' checked' : ''}/></span><span>第 ${n} 條</span></label>`
    + `${checked ? '<span class="signCenter_alreadyReadLabel__x"> 已閱讀條款 </span>' : ''}</p>`;

interface SignFixture {
    clauses?: boolean[];
    downloaded?: boolean;
    confirmed?: boolean;
    rows?: { status: string; selected?: boolean }[];
    countdown?: number;
}

function signPage({ clauses = [false, false, false], downloaded = false, confirmed = false, rows, countdown = 0 }: SignFixture = {}) {
    const table = rows && rows.length ? `
        <div class="signCenter_paragraph__3GyNM"><div class="signCenter_signID_block__a">簽署人身分證字號 : A123456789</div>
        <div class="ant-table-wrapper"><div class="ant-table"><table>
            <thead class="ant-table-thead"><tr><th></th><th>分公司</th><th>帳號</th><th>簽署與否</th><th>python 測試與否</th></tr></thead>
            <tbody class="ant-table-tbody">${rows.map((row, i) => `
                <tr class="ant-table-row${row.selected ? ' ant-table-row-selected' : ''}" data-row-key="${i}">
                    <td><label class="ant-checkbox-wrapper${row.selected ? ' ant-checkbox-wrapper-checked' : ''}"><span class="ant-checkbox"><input type="checkbox"/></span></label></td>
                    <td><div>城中</div></td><td><div>98765${i}</div></td>
                    <td><div><span class="signCenter_label__q signCenter_notSigned__w">${row.status}</span></div></td>
                    <td><div><span class="signCenter_label__q">未測試</span></div></td>
                </tr>`).join('')}
            </tbody></table></div></div></div>` : '';
    return `
        <header><div class="navbar"><a class="navbar__account">王小明 您好 A1</a><button>登出</button></div></header>
        <div id="page__container">
            <div class="signCenter_agreement_container__23cNW">
                <div class="signCenter_title__3kUqE"> API電子交易風險預告書暨使用同意書 (證券)</div>
                ${clauses.map((checked, i) => clause(i + 1, checked)).join('')}
                <h5>依主管機關規定，需點選下載【API電子交易風險預告書暨使用同意書】PDF副本</h5>
                <span class="signCenter_red__btn__l__1rg51">下載【 API 電子交易風險預告書暨使用同意書 】</span>
                ${downloaded ? `<h5><label class="ant-checkbox-wrapper${confirmed ? ' ant-checkbox-wrapper-checked' : ''} signCenter_paragraph__3GyNM"><span class="ant-checkbox"><input type="checkbox"/></span><span>我<span>已確認簽署並已下載</span>【 API電子交易風險預告書暨使用同意書 】</span></label></h5>` : ''}
            </div>
            <div class="signCenter_account_container__xm4_E">${table}
                <div class="signCenter_sign__btn__block__1iDom"><button disabled type="button" class="ant-btn ant-btn-primary ant-btn-lg signCenter_sign__btn__3VaWy"><span>${countdown ? `${countdown} 秒後可簽署` : '簽 署'}</span></button></div>
            </div>
        </div>`;
}

const opened: Window[] = [];
afterEach(async () => { for (const win of opened.splice(0)) await win.happyDOM.close(); });

/** 建一個官網頁面、注入腳本（DEBUG 照參數），回傳 window 與工具。 */
function load(url: string, html: string, debug = false, options: LoadOptions = {}) {
    const win = new Window({ url, settings: { disableJavaScriptEvaluation: true }, ...(options.viewport ? { width: options.viewport.width, height: options.viewport.height } : {}) });
    opened.push(win);
    // happy-dom 沒有版面：所有元素都當成看得見
    win.HTMLElement.prototype.getBoundingClientRect = function (this: Element) {
        const box = options.rect?.(this) ?? { left: 0, top: 0, width: 10, height: 10 };
        return { x: box.left, y: box.top, top: box.top, left: box.left, right: box.left + box.width, bottom: box.top + box.height, width: box.width, height: box.height, toJSON: () => ({}) } as never;
    };
    // 卡片用 closed shadow root：測試從這裡拿到它
    const roots: ShadowRoot[] = [];
    const attach = win.Element.prototype.attachShadow;
    win.Element.prototype.attachShadow = function (this: Element, init: ShadowRootInit) {
        const root = attach.call(this, init) as unknown as ShadowRoot;
        roots.push(root);
        return root as never;
    };
    win.HTMLElement.prototype.scrollIntoView = () => undefined;
    options.before?.(win);
    win.document.title = '簽署中心';
    win.document.body.innerHTML = html;
    const source = fs.readFileSync(SCRIPT, 'utf8')
        .replace('__SJPRO_GUIDE_CONFIG__', JSON.stringify(APPLY_PAGE_RULES))
        .replace('__SJPRO_GUIDE_DEBUG__', debug ? 'true' : 'false')
        .replace('__SJPRO_GUIDE_CARD_KEY__', CARD_KEY);
    const run = new Function('window', 'document', 'location', 'MutationObserver', 'setTimeout', 'setInterval', 'clearInterval', source);
    run(win, win.document, win.location, win.MutationObserver, win.setTimeout.bind(win), win.setInterval.bind(win), win.clearInterval.bind(win));
    const guide = (win as unknown as { __sjproApplyGuide: { focus: (id: string | null) => void; card: (key: unknown, data: unknown) => void } }).__sjproApplyGuide;
    return {
        win,
        guide,
        roots,
        /** 卡片（沒有就 null） */
        card: () => (roots[0]?.querySelector('section.card') as unknown as HTMLElement | null) ?? null,
        nav: () => win.document.title.split(NAV_MARK)[1]?.split(' ')[0] ?? null,
        marker: () => win.document.title.split(MARK)[1] ?? null,
        // 重新偵測（等同 MutationObserver 觸發）
        refresh: () => guide.focus(null),
        focus: (id: string) => guide.focus(id),
        highlighted: () => [...win.document.querySelectorAll('*')].filter(el => (el as unknown as HTMLElement).style.outline.includes('solid')),
        set: (next: string) => { win.document.body.innerHTML = next; guide.focus(null); },
    };
}

const S_URL = 'https://www.sinotrade.com.tw/newweb/signCenter/S_openAPI/';
const F_URL = 'https://www.sinotrade.com.tw/newweb/signCenter/F_openApi/';
const H_URL = 'https://www.sinotrade.com.tw/newweb/signCenter/H_openApi/';

describe.skipIf(!hasScript)('apply window guide script on the signing pages', () => {
    it('names the signing page from the URL and reads the account table conservatively', () => {
        expect(load(S_URL, signPage({ rows: [{ status: '已簽署' }, { status: '未簽署' }] })).marker()).toBe('sign-s:unsigned');
        expect(load(F_URL, signPage({ rows: [{ status: '已簽署' }, { status: '已簽署' }] })).marker()).toBe('sign-f:signed');
        expect(load(F_URL, signPage({ rows: [{ status: '審核中' }, { status: '已簽署' }] })).marker()).toBe('sign-f:pending');
        // 沒有表格（還在載入、沒登入、沒有這類帳戶）或讀不到狀態：未確認
        expect(load(H_URL, signPage()).marker()).toBe('sign-h:unknown');
        expect(load(H_URL, signPage({ rows: [{ status: '—' }] })).marker()).toBe('sign-h:unknown');
        // 已簽署要每一列都讀得到：有一列讀不到就是未確認
        expect(load(H_URL, signPage({ rows: [{ status: '已簽署' }, { status: '' }] })).marker()).toBe('sign-h:unknown');
        expect(load(H_URL, signPage({ rows: [{ status: '—' }, { status: '未簽署' }] })).marker()).toBe('sign-h:unsigned');
        // 網址大小寫不同也認得
        expect(load('https://www.sinotrade.com.tw/newweb/signcenter/s_openapi/', signPage()).marker()).toBe('sign-s:unknown');
    });

    it('follows the page when the table appears after loading', () => {
        const page = load(S_URL, signPage());
        expect(page.marker()).toBe('sign-s:unknown');
        page.set(signPage({ rows: [{ status: '未簽署' }] }));
        expect(page.marker()).toBe('sign-s:unsigned');
        page.set(signPage({ rows: [{ status: '已簽署' }] }));
        expect(page.marker()).toBe('sign-s:signed');
    });

    it('points at one control at a time in signing order and never at a signed page', () => {
        const rows = [{ status: '未簽署' }];
        const page = load(S_URL, signPage({ rows, countdown: 9 }));
        const only = () => { const els = page.highlighted(); expect(els).toHaveLength(1); return els[0]!; };
        expect(only().className).toContain('paragraphTitle');
        expect(only().textContent).toContain('第 1 條');
        page.set(signPage({ rows, clauses: [true, false, true] }));
        expect(only().textContent).toContain('第 2 條');
        page.set(signPage({ rows, clauses: [true, true, true] }));
        expect(only().className).toContain('red__btn');
        page.set(signPage({ rows, clauses: [true, true, true], downloaded: true }));
        expect(only().textContent).toContain('已確認簽署並已下載');
        page.set(signPage({ rows, clauses: [true, true, true], downloaded: true, confirmed: true }));
        expect(only().className).toContain('ant-table-wrapper');
        page.set(signPage({ rows: [{ status: '未簽署', selected: true }], clauses: [true, true, true], downloaded: true, confirmed: true }));
        expect(only().tagName).toBe('BUTTON');
        page.set(signPage({ rows: [{ status: '已簽署' }], clauses: [true, true, true] }));
        expect(page.highlighted()).toHaveLength(0);
    });

    it('highlights a control the app asks for on the open signing page only', () => {
        const page = load(F_URL, signPage({ rows: [{ status: '未簽署' }] }));
        page.focus('sign-f-download');
        expect(page.highlighted()[0]!.className).toContain('red__btn');
        page.focus('sign-s-download'); // 另一個市場的目標：不標示錯的頁面
        expect(page.highlighted()[0]!.className).toContain('paragraphTitle');
    });

    it('keeps the old marker on the other pages', () => {
        const list = load('https://www.sinotrade.com.tw/newweb/PythonAPIKey/', '<div>API 管理</div>');
        expect(list.marker()).toBe('list');
        expect(load('https://www.sinotrade.com.tw/', '<a>客戶登入</a>').marker()).toBe('login');
    });

    it('reports only known site wording, lengths and counts in debug builds only', () => {
        // 頁首以外也可能有姓名：一律不輸出原文
        const html = signPage({ rows: [{ status: '未簽署' }], countdown: 9 })
            + '<h2>王小明 您好</h2><div class="ant-message">陳大文 簽署成功</div><button>林美 A12</button>';
        expect(load(S_URL, html).win.document.title).not.toContain(DOM_MARK);
        const page = load(S_URL, html, true);
        const title = page.win.document.title;
        expect(title).toContain(DOM_MARK);
        expect(page.marker()).toBe('sign-s:unsigned');
        const summary = title.split(DOM_MARK)[1]!.split(MARK)[0]!;
        expect(summary).toContain('未簽署');
        expect(summary).toContain('簽署與否');
        expect(summary).toContain('秒後可簽署');
        expect(summary).toContain('測試與否');
        expect(summary).toContain('簽署成功');
        expect(summary).toContain('rows=1');
        expect(summary).toContain('box=0/4');
        // 不認得的文字只剩長度（?5＝五個字）；沒有姓名、分行、帳號或身分證字號
        expect(summary).toContain('?5');
        for (const word of ['王小明', '陳大文', '林美', '城中', '您好', '98765', 'A123']) expect(summary).not.toContain(word);
        const words = summary.split(';').flatMap(part => part.replace(/^[a-z]+=/, '').split('/')).filter(Boolean);
        for (const word of words) expect(word).toMatch(/^(\?\d+|\d+(\/\d+)?|[\u4e00-\u9fff]+)$/);
        // 非簽署頁不回報
        expect(load('https://www.sinotrade.com.tw/newweb/PythonAPIKey/', '<h1>API 管理</h1>', true).win.document.title).not.toContain(DOM_MARK);
    });
});

// ── 網頁說明卡 ───────────────────────────────────────────────────────

const LIST_URL = 'https://www.sinotrade.com.tw/newweb/PythonAPIKey/';
const options = { canPrev: true, canNext: true, theme: 'dark', large: false } as const;
const VIEW = { width: 1120, height: 860 };
const CARD = { width: 360, height: 260 };
/** 卡片在 shadow root 裡：給它固定大小；其他元素照 data-rect="left,top,width,height" */
const layout = (el: Element): Box | null => {
    if (el.getRootNode() !== el.ownerDocument) return el.matches('section.card') ? { left: 0, top: 0, ...CARD } : null;
    const rect = el.getAttribute('data-rect');
    if (!rect) return null;
    const [left, top, width, height] = rect.split(',').map(Number) as [number, number, number, number];
    return { left, top, width, height };
};
const boxOf = (card: HTMLElement) => {
    const left = parseFloat(card.style.left);
    const top = parseFloat(card.style.top);
    return { left, top, right: left + CARD.width, bottom: top + CARD.height };
};
const overlaps = (a: { left: number; top: number; right: number; bottom: number }, b: Box, pad = 0) =>
    a.left < b.left + b.width + pad && a.right > b.left - pad && a.top < b.top + b.height + pad && a.bottom > b.top - pad;
const text = (el: Element | null) => (el?.textContent ?? '').replace(/\s+/g, '');
const listPage = (extra = '') => `<div class="ant-table-title"><button data-rect="900,20,140,40">新增 API Key</button><button data-rect="40,20,120,40">下載憑證</button></div>${extra}`;

describe.skipIf(!hasScript)('apply window guide card', () => {
    it('shows the app copy in a closed shadow root, only for the window nonce', () => {
        const page = load(LIST_URL, listPage(), false, { rect: layout, viewport: VIEW });
        expect(page.card()).toBeNull();
        const card = guideCardOf('list', options);
        // 官網自己的程式也碰得到 window.__sjproApplyGuide：沒有 nonce 就不理
        page.guide.card('', card);
        page.guide.card('__SJPRO_GUIDE_CARD_KEY__', card);
        page.guide.card(CARD_KEY.toUpperCase(), card);
        expect(page.roots).toHaveLength(0);
        page.guide.card(CARD_KEY, card);
        expect(page.roots).toHaveLength(1);
        const host = page.win.document.documentElement.lastElementChild!;
        expect(host.tagName.toLowerCase()).toBe('div'); // 不用自訂標籤：官網可能先註冊同名元素
        expect(host.shadowRoot).toBeNull(); // closed
        expect(page.win.document.body.textContent).not.toContain('Shioaji Pro 導覽');
        // 框起「新增 API Key」：卡片顯示那一項
        expect(text(page.card()!.querySelector('.title'))).toBe('按「新增APIKey」'); // 「」只給讀螢幕軟體
        expect(page.card()!.querySelector('.title .chip')!.textContent).toContain('新增 API Key');
        expect(text(page.card()!.querySelector('.progress'))).toBe('第3步，共6步：API管理');
        expect(text(page.card())).toContain('黃色框就是這一項的位置');
        // App 要標示「下載憑證」：卡片跟著換
        page.focus('download-ca');
        expect(text(page.card()!.querySelector('.title'))).toBe('正式環境還要「下載憑證」');
        // 沒有框到任何東西：顯示這一步的標題與說明
        page.set('<div>API 管理</div>');
        expect(text(page.card()!.querySelector('.title'))).toBe(text({ textContent: card.title } as Element));
        expect(text(page.card()!.querySelector('.text'))).toContain('登入成功，這是API管理頁');
        // null 拿掉卡片
        page.guide.card(CARD_KEY, null);
        expect(page.card()).toBeNull();
    });

    it('renders text only, never markup from the data', () => {
        const page = load(LIST_URL, '<div>API 管理</div>', false, { rect: layout, viewport: VIEW });
        page.guide.card(CARD_KEY, { ...guideCardOf('list', options), title: '<img src=x onerror=alert(1)>', lead: '<b>粗</b>', theme: '<x>' });
        const el = page.card()!;
        expect(el.querySelector('img, b')).toBeNull();
        expect(el.querySelector('.title')!.textContent).toBe('<img src=x onerror=alert(1)>');
        expect(el.className).toContain('dark');
        // 格式不對的資料不會弄壞頁面
        expect(() => page.guide.card(CARD_KEY, { points: 'x', progress: 3 })).not.toThrow();
        expect(() => page.guide.card(CARD_KEY, 'card')).not.toThrow();
        expect(page.card()).toBeNull();
    });

    it('stays beside the highlighted element without covering it', () => {
        const page = load(LIST_URL, listPage(), false, { rect: layout, viewport: VIEW });
        page.guide.card(CARD_KEY, guideCardOf('list', options));
        const target = { left: 900, top: 20, width: 140, height: 40 };
        const box = boxOf(page.card()!);
        expect(overlaps(box, target, 15)).toBe(false);
        expect(box.top).toBeGreaterThanOrEqual(target.top + target.height + 15); // 下方
        expect(box.right).toBeLessThanOrEqual(VIEW.width - 12);
        expect(box.left).toBeGreaterThanOrEqual(12);
    });

    it('moves beside the field instead of over the next fields of a form', () => {
        const field = (y: number, id = '') => `<input ${id} data-rect="300,${y},400,32" />`;
        const html = `<div class="ant-modal" data-rect="260,100,520,600"><div class="ant-modal-title">新增 API KEY</div>
            ${field(200, 'id="apiKeyName"')}${field(250)}${field(300)}${field(350)}${field(400)}${field(450)}</div>`;
        const page = load(LIST_URL, html, false, { rect: layout, viewport: VIEW });
        expect(page.marker()).toBe('form');
        page.guide.card(CARD_KEY, guideCardOf('form', options));
        expect(text(page.card()!.querySelector('.title'))).toBe('APIKey名稱');
        const box = boxOf(page.card()!);
        for (const y of [200, 250, 300, 350, 400, 450]) expect(overlaps(box, { left: 300, top: y, width: 400, height: 32 }), String(y)).toBe(false);
        expect(box.left).toBeGreaterThanOrEqual(700 + 15); // 右邊
    });

    it('goes above an element near the bottom, and folds up when no spot keeps it clear', () => {
        // 寬的元素，右邊、左邊都放不下
        const low = load(LIST_URL, `<button data-rect="300,780,600,40">新增 API Key</button>`, false, { rect: layout, viewport: VIEW });
        low.guide.card(CARD_KEY, guideCardOf('list', options));
        const box = boxOf(low.card()!);
        expect(box.bottom).toBeLessThanOrEqual(780 - 15);
        expect(box.top).toBeGreaterThanOrEqual(12);
        // 標示的東西幾乎占滿畫面（例如簽署頁的帳戶表格）：卡片縮成一條，不擋住它
        const big = load(LIST_URL, `<button data-rect="20,20,1080,820">新增 API Key</button>`, false, { rect: layout, viewport: VIEW });
        big.guide.card(CARD_KEY, guideCardOf('list', options));
        expect(big.card()!.className).toContain('folded');
        expect(big.card()!.querySelector('.foot')).toBeNull();
    });

    it('reports the buttons through the title marker only, without touching the site', () => {
        const page = load(LIST_URL, listPage(), false, { rect: layout, viewport: VIEW });
        let siteClicks = 0;
        for (const type of ['click', 'pointerdown', 'mousedown', 'keydown']) page.win.document.addEventListener(type, () => { siteClicks++; });
        page.guide.card(CARD_KEY, guideCardOf('list', { ...options, canPrev: false }));
        const buttons = [...page.card()!.querySelectorAll('.foot button')] as unknown as HTMLButtonElement[];
        const [prev, next] = buttons;
        expect(prev!.disabled).toBe(true);
        next!.click();
        const first = page.nav();
        expect(first).toMatch(/^next\.\d+$/);
        expect(page.marker()).toBe('list'); // 步驟標記還在
        next!.click();
        const second = page.nav();
        expect(second).toMatch(/^next\.\d+$/);
        expect(second).not.toBe(first); // 同一顆按兩次是兩次
        prev!.click(); // 不能上一步：不回報
        expect(page.nav()).toBe(second);
        // 縮小、展開只在網頁上
        (page.card()!.querySelector('button[aria-label="縮小說明"]') as unknown as HTMLButtonElement).click();
        expect(page.card()!.className).toContain('folded');
        expect(page.nav()).toBe(second);
        (page.card()!.querySelector('button[aria-label="展開說明"]') as unknown as HTMLButtonElement).click();
        expect(page.card()!.className).not.toContain('folded');
        // 關掉：拿掉卡片並告訴 App
        (page.card()!.querySelector('button[aria-label^="關閉網頁上的說明"]') as unknown as HTMLButtonElement).click();
        expect(page.card()).toBeNull();
        expect(page.nav()).toMatch(/^hide\.\d+$/);
        // 之後同一張卡不再出現；App 送 null（使用者關掉）再送卡（重新打開）才出現
        page.guide.card(CARD_KEY, guideCardOf('list', options));
        expect(page.card()).toBeNull();
        page.guide.card(CARD_KEY, null);
        page.guide.card(CARD_KEY, guideCardOf('list', options));
        expect(page.card()).not.toBeNull();
        // 卡片的點擊不會傳到官網的頁面
        expect(siteClicks).toBe(0);
    });

    it('drops the button marker from the title after a moment and keeps the site title', async () => {
        const page = load(LIST_URL, listPage(), false, { rect: layout, viewport: VIEW });
        page.guide.card(CARD_KEY, guideCardOf('list', options));
        (page.card()!.querySelectorAll('.foot button')[1] as unknown as HTMLButtonElement).click();
        expect(page.win.document.title.startsWith('簽署中心' + NAV_MARK)).toBe(true);
        await new Promise(resolve => page.win.setTimeout(resolve, 600));
        expect(page.nav()).toBeNull();
        expect(page.win.document.title).toBe('簽署中心' + MARK + 'list');
    });

    it("keeps the app wording even when the site replaces built-ins after it loaded", () => {
        const page = load(LIST_URL, listPage(), false, { rect: layout, viewport: VIEW });
        const caught: unknown[] = [];
        // （String.prototype.split 不測：happy-dom 自己是 JS，內部也會用它）
        const saved = { slice: String.prototype.slice, isArray: Array.isArray };
        const proto = { append: page.win.Node.prototype.appendChild, text: page.win.Document.prototype.createTextNode, attr: page.win.Element.prototype.setAttribute };
        try {
            // 官網的程式（沒有 nonce）等 App 送卡片時換掉內建函式
            String.prototype.slice = function () { return "偽造"; } as never;
            Array.isArray = (() => false) as never;
            page.win.Node.prototype.appendChild = function (this: Node, child: Node) { caught.push(child); return child; } as never;
            page.win.Document.prototype.createTextNode = function () { return proto.text.call(page.win.document, "偽造"); } as never;
            page.win.Element.prototype.setAttribute = function (this: Element) { caught.push(this); } as never;
            page.guide.card(CARD_KEY, guideCardOf("list", options));
        } finally {
            String.prototype.slice = saved.slice; Array.isArray = saved.isArray;
            page.win.Node.prototype.appendChild = proto.append; page.win.Document.prototype.createTextNode = proto.text; page.win.Element.prototype.setAttribute = proto.attr;
        }
        expect(text(page.card()!.querySelector(".title"))).toBe("按「新增APIKey」");
        expect(text(page.card())).not.toContain("偽造");
        expect(caught).toHaveLength(0); // 卡片的節點沒有經過官網換掉的函式
    });

    it("keeps the app copy when the site adds index setters or default fields to the prototypes", () => {
        const page = load(LIST_URL, listPage(), false, { rect: layout, viewport: VIEW });
        const card = guideCardOf("list", options);
        const point = { ...card.points[0]! };
        delete (point as { tone?: string }).tone;
        const caught = new Set<unknown>(); // 不用陣列：陣列本身也會經過這個 setter
        try {
            // 官網在 Array.prototype 放索引 setter、在 Object.prototype 放預設欄位
            Object.defineProperty(Array.prototype, "0", {
                configurable: true,
                set(this: unknown[], value: unknown) {
                    if (typeof value === "string" || (value && typeof value === "object" && "body" in value)) caught.add(value);
                    Object.defineProperty(this, "0", { value, writable: true, enumerable: true, configurable: true });
                },
            });
            Object.defineProperty(Object.prototype, "tone", { configurable: true, get: () => "caution" });
            page.guide.card(CARD_KEY, { ...card, points: [point, ...card.points.slice(1)] });
        } finally {
            delete (Array.prototype as unknown as Record<string, unknown>)["0"];
            delete (Object.prototype as unknown as Record<string, unknown>).tone;
        }
        expect([...caught].filter(value => value === "add-key" || (typeof value === "object" && value !== null && "targets" in value))).toEqual([]); // 卡片內容沒有經過官網的 setter
        expect(text(page.card()!.querySelector(".title"))).toBe("按「新增APIKey」");
        expect(page.card()!.querySelector(".tag")).toBeNull(); // 沒有的欄位不從原型讀
    });

    it("keeps keyboard focus on the same button when the card is drawn again", () => {
        const page = load(LIST_URL, listPage(), false, { rect: layout, viewport: VIEW });
        page.guide.card(CARD_KEY, guideCardOf("list", options));
        const root = page.roots[0]!;
        (page.card()!.querySelectorAll(".foot button")[1] as unknown as HTMLButtonElement).focus();
        expect((root.activeElement as HTMLElement | null)?.textContent).toContain("下一步");
        // App 換了標示的項目：卡片重畫，焦點留在新的「下一步」
        page.focus("download-ca");
        expect(text(page.card()!.querySelector(".title"))).toBe("正式環境還要「下載憑證」");
        expect(root.activeElement).toBe(page.card()!.querySelectorAll(".foot button")[1]);
        // 縮小：「下一步」不見了，焦點交給展開鈕，不掉回官網
        (page.card()!.querySelector("button[aria-label=\"縮小說明\"]") as unknown as HTMLButtonElement).click();
        expect(root.activeElement).toBe(page.card()!.querySelector("button[aria-label=\"展開說明\"]"));
        // 焦點不在卡片上：重畫不搶焦點
        (page.win.document.querySelector("button") as unknown as HTMLButtonElement).focus();
        page.guide.card(CARD_KEY, guideCardOf("form", options));
        expect(root.activeElement).toBeNull();
    });

    it("never hands card buttons to getters the site replaced, while keeping focus", () => {
        // happy-dom 的 focus() 是 JS、自己會讀 disabled；瀏覽器的 focus() 不經過頁面的 getter：標出這段不算
        let inFocus = 0;
        const page = load(LIST_URL, listPage(), false, {
            rect: layout, viewport: VIEW,
            before: win => {
                const focus = win.HTMLElement.prototype.focus;
                win.HTMLElement.prototype.focus = function (this: HTMLElement, ...args: unknown[]) {
                    inFocus++;
                    try { return focus.apply(this, args as never); } finally { inFocus--; }
                };
            },
        });
        page.guide.card(CARD_KEY, guideCardOf("list", options));
        const root = page.roots[0]!;
        (page.card()!.querySelectorAll(".foot button")[1] as unknown as HTMLButtonElement).focus();
        const proto = page.win.HTMLButtonElement.prototype;
        const saved = Object.getOwnPropertyDescriptor(proto, "disabled");
        const leaked: unknown[] = [];
        try {
            // 官網換掉 disabled 的 getter，想在卡片重畫時拿到卡片裡的按鈕
            Object.defineProperty(proto, "disabled", { configurable: true, get(this: Element) {
                if (this.getRootNode() !== this.ownerDocument && inFocus === 0) leaked.push(this);
                return false;
            } });
            page.focus("download-ca");
        } finally {
            if (saved) Object.defineProperty(proto, "disabled", saved); else delete (proto as unknown as Record<string, unknown>).disabled;
        }
        expect(leaked).toHaveLength(0);
        expect(root.activeElement).toBe(page.card()!.querySelectorAll(".foot button")[1]);
    });

    it("still shows the card when the site adds get or set to Object.prototype", () => {
        const page = load(LIST_URL, listPage(), false, { rect: layout, viewport: VIEW });
        try {
            Object.defineProperty(Object.prototype, "get", { configurable: true, get: () => undefined });
            page.guide.card(CARD_KEY, guideCardOf("list", options));
        } finally {
            delete (Object.prototype as unknown as Record<string, unknown>).get;
        }
        expect(text(page.card()!.querySelector(".title"))).toBe("按「新增APIKey」");
    });

    it("measures new content again instead of staying folded from an earlier card", () => {
        const small = { width: 640, height: 520 };
        // 卡片高度跟著內容：長的放不下、短的放得下
        const sized = (el: Element): Box | null => el.getRootNode() !== el.ownerDocument && el.matches("section.card")
            ? { left: 0, top: 0, width: 360, height: (el.textContent ?? "").length > 120 ? 400 : 120 }
            : layout(el);
        const page = load(LIST_URL, `<button data-rect="20,200,600,100">新增 API Key</button>`, false, { rect: sized, viewport: small });
        const long = guideCardOf("list", options);
        page.guide.card(CARD_KEY, { ...long, points: [{ ...long.points[0]!, body: "很長的說明".repeat(30) }] });
        expect(page.card()!.className).toContain("folded");
        page.guide.card(CARD_KEY, { ...long, points: [{ ...long.points[0]!, body: "短說明" }] });
        expect(page.card()!.className).not.toContain("folded");
        expect(page.card()!.querySelector(".foot")).not.toBeNull();
    });
});
