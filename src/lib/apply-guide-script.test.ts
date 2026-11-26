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
import { APPLY_PAGE_RULES } from './apply-guide-config';

const SCRIPT = path.resolve(__dirname, '../../src-tauri/src/apply_window_guide.js');
const hasScript = fs.existsSync(SCRIPT);
const MARK = ' ⁣sjpro-step:';
const DOM_MARK = ' ⁣sjpro-dom:';

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
function load(url: string, html: string, debug = false) {
    const win = new Window({ url, settings: { disableJavaScriptEvaluation: true } });
    opened.push(win);
    // happy-dom 沒有版面：所有元素都當成看得見
    win.HTMLElement.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 10, bottom: 10, width: 10, height: 10, toJSON: () => ({}) }) as never;
    win.HTMLElement.prototype.scrollIntoView = () => undefined;
    win.document.title = '簽署中心';
    win.document.body.innerHTML = html;
    const source = fs.readFileSync(SCRIPT, 'utf8')
        .replace('__SJPRO_GUIDE_CONFIG__', JSON.stringify(APPLY_PAGE_RULES))
        .replace('__SJPRO_GUIDE_DEBUG__', debug ? 'true' : 'false');
    const run = new Function('window', 'document', 'location', 'MutationObserver', 'setTimeout', 'setInterval', 'clearInterval', source);
    run(win, win.document, win.location, win.MutationObserver, win.setTimeout.bind(win), win.setInterval.bind(win), win.clearInterval.bind(win));
    const guide = (win as unknown as { __sjproApplyGuide: { focus: (id: string | null) => void } }).__sjproApplyGuide;
    return {
        win,
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

    it('reports an anonymized structure summary in debug builds only', () => {
        const html = signPage({ rows: [{ status: '未簽署' }], countdown: 9 });
        expect(load(S_URL, html).win.document.title).not.toContain(DOM_MARK);
        const page = load(S_URL, html, true);
        const title = page.win.document.title;
        expect(title).toContain(DOM_MARK);
        expect(page.marker()).toBe('sign-s:unsigned');
        const summary = title.split(DOM_MARK)[1]!.split(MARK)[0]!;
        expect(summary).toContain('未簽署');
        expect(summary).toContain('簽署與否');
        expect(summary).toContain('秒後可簽署');
        expect(summary).toContain('rows=1');
        expect(summary).toContain('box=0/4');
        // 沒有數字、英文字母，也沒有頁首（問候語裡的名字）
        expect(summary.replace(/rows=\d+|box=\d+\/\d+|\b[hbsm]=|th=/g, '')).not.toMatch(/[0-9A-Za-z]/);
        expect(summary).not.toContain('王小明');
        expect(summary).not.toContain('城中');
        // 非簽署頁不回報
        expect(load('https://www.sinotrade.com.tw/newweb/PythonAPIKey/', '<h1>API 管理</h1>', true).win.document.title).not.toContain(DOM_MARK);
    });
});
