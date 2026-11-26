import { describe, expect, it, vi } from 'vitest';
vi.mock('./tauri', () => ({ openExternalUrl: vi.fn() }));
import {
    APPLY_PAGE_RULES, GUIDE_COPY, GUIDE_ORDER, PRODUCTION_NEXT_STEPS, SIGN_STEPS, SIGNING_MARKETS,
    guideStepOf, nextGuideStep, previousGuideStep, isApplyPageStep, signTargetId,
} from './apply-guide-config';
import { SIGNING_URLS } from './account-signing';
import { parseApplyGuideEvent } from './apply-guide-native';

// 與 Rust 端 apply_window.rs 的 GuideConfig::validate 相同的限制：
// 不符合時原生殼會拒絕開啟申請視窗。
const ID = /^[a-z0-9-]{1,40}$/;
const validText = (value: string) => value.trim().length > 0 && [...value].length <= 200 && !/\p{Cc}/u.test(value);

describe('apply guide page rules', () => {
    it('match the native validation rules', () => {
        expect(validText(APPLY_PAGE_RULES.modalSelector)).toBe(true);
        expect(validText(APPLY_PAGE_RULES.modalTitleSelector)).toBe(true);
        expect(APPLY_PAGE_RULES.steps.length).toBeGreaterThan(0);
        expect(APPLY_PAGE_RULES.steps.length).toBeLessThanOrEqual(16);
        expect(APPLY_PAGE_RULES.targets.length).toBeLessThanOrEqual(64);
        for (const rule of APPLY_PAGE_RULES.steps) {
            expect(rule.id).toMatch(ID);
            expect([rule.modalTitle, rule.pathPrefix].filter(Boolean)).toHaveLength(1);
            // 簽署頁一定是網址判斷（Rust 端同樣檢查）
            if (rule.sign) expect(rule.pathPrefix).toBeTruthy();
            expect(Object.keys(rule).every(key => ['id', 'modalTitle', 'pathPrefix', 'sign'].includes(key))).toBe(true);
            for (const value of [rule.modalTitle, rule.pathPrefix]) if (value) expect(validText(value)).toBe(true);
        }
        const ids = new Set<string>();
        for (const target of APPLY_PAGE_RULES.targets) {
            expect(target.id).toMatch(ID);
            expect(ids.has(target.id)).toBe(false);
            ids.add(target.id);
            expect(isApplyPageStep(target.step)).toBe(true);
            expect(target.selector || target.text).toBeTruthy();
            for (const value of [target.selector, target.closest, target.text, target.unless]) if (value) expect(validText(value)).toBe(true);
            // 只送原生殼認得的欄位（Rust 端 deny_unknown_fields）
            expect(Object.keys(target).every(key => ['id', 'step', 'selector', 'closest', 'text', 'unless', 'auto'].includes(key))).toBe(true);
        }
        const sign = APPLY_PAGE_RULES.signStatus;
        expect(Object.keys(sign).sort()).toEqual(['pending', 'rowSelector', 'signed', 'unsigned']);
        for (const value of Object.values(sign)) expect(validText(value)).toBe(true);
        expect(Object.keys(APPLY_PAGE_RULES).sort()).toEqual(['modalSelector', 'modalTitleSelector', 'signStatus', 'steps', 'targets']);
    });

    it('opens each signing page from its fixed URL and detects it before the generic paths', () => {
        const order = APPLY_PAGE_RULES.steps.map(rule => rule.id);
        for (const market of SIGNING_MARKETS) {
            const rule = APPLY_PAGE_RULES.steps.find(r => r.id === SIGN_STEPS[market])!;
            expect(rule.sign).toBe(true);
            // 偵測用的路徑就是簽署頁網址的路徑
            expect(new URL(SIGNING_URLS[market].url).pathname.toLowerCase()).toContain(rule.pathPrefix!.toLowerCase());
            expect(SIGNING_URLS[market].url).toMatch(/^https:\/\/www\.sinotrade\.com\.tw\/newweb\/signCenter\//);
            expect(order.indexOf(rule.id)).toBeLessThan(order.indexOf('login'));
            expect(guideStepOf(rule.id)).toBe('sign');
        }
        expect(guideStepOf('list')).toBe('list');
        expect(signTargetId('sign-f', 'terms')).toBe('sign-f-terms');
        expect(signTargetId('list', 'terms')).toBeNull();
        expect(signTargetId(null, 'terms')).toBeNull();
    });

    it('detects open modals before falling back to the page path', () => {
        const order = APPLY_PAGE_RULES.steps.map(rule => rule.id);
        expect(order.slice(0, 3)).toEqual(['success', 'form', 'verify']);
        expect(order.at(-1)).toBe('login');
        expect(APPLY_PAGE_RULES.steps.at(-1)!.pathPrefix).toBe('/');
    });

    it('auto-highlights at most one target per step and every guide target exists on its step', () => {
        for (const step of APPLY_PAGE_RULES.steps) {
            // 簽署頁依序標示好幾個（做完一個換下一個）；登入頁先標登入框的「登入」，沒有登入框才標「客戶登入」；其他步驟最多一個
            if (step.sign) continue;
            if (step.id === 'login') {
                expect(APPLY_PAGE_RULES.targets.filter(t => t.step === 'login' && t.auto).map(t => t.id)).toEqual(['login-submit', 'login-button']);
                continue;
            }
            expect(APPLY_PAGE_RULES.targets.filter(t => t.step === step.id && t.auto).length).toBeLessThanOrEqual(1);
        }
        for (const step of GUIDE_ORDER) {
            for (const point of GUIDE_COPY[step].points) {
                if (!point.target) continue;
                if (step === 'sign') {
                    // 簽署步驟的目標依目前打開的簽署頁，三個市場都要有
                    for (const market of SIGNING_MARKETS) {
                        const target = APPLY_PAGE_RULES.targets.find(t => t.id === signTargetId(SIGN_STEPS[market], point.target!));
                        expect(target, `${market}: ${point.target}`).toBeDefined();
                        expect(target!.step).toBe(SIGN_STEPS[market]);
                    }
                    continue;
                }
                const target = APPLY_PAGE_RULES.targets.find(t => t.id === point.target);
                expect(target, `${step}: ${point.target}`).toBeDefined();
                expect(target!.step).toBe(step);
            }
        }
    });
});

describe('apply guide copy', () => {
    it('sends the verification code to the phone only, never mentioning Email', () => {
        const all = JSON.stringify(GUIDE_COPY);
        expect(all).not.toMatch(/e-?mail|信箱/i);
        expect(GUIDE_COPY.start.points[0]!.body).toContain('開戶時留的手機號碼');
        expect(GUIDE_COPY.verify.lead).toContain('開戶時留的手機號碼');
    });

    it('covers every page step and explains each form field', () => {
        for (const rule of APPLY_PAGE_RULES.steps) expect(GUIDE_COPY[guideStepOf(rule.id)].title).toBeTruthy();
        const form = GUIDE_COPY.form.points.map(point => point.title).join('\n');
        for (const field of ['API Key 名稱', '到期時間', '行情／資料', '帳務', '交易', '正式環境', '選擇帳戶', '限制 IP', '無限制 IP', '確定']) {
            expect(form).toContain(field);
        }
        const prod = GUIDE_COPY.form.points.find(point => point.target === 'perm-prod')!;
        expect(prod.body).toContain('只能登入模擬環境');
        expect(GUIDE_COPY.success.points.map(p => p.title).join()).toContain('Secret Key 只會顯示這一次');
        expect(GUIDE_COPY.list.title).toContain('新增 API Key');
    });

    it('moves through the steps in order and stays within bounds', () => {
        expect(GUIDE_ORDER).toEqual(['start', 'login', 'sign', 'list', 'verify', 'form', 'success', 'imported']);
        expect(nextGuideStep('login')).toBe('sign');
        expect(nextGuideStep('sign')).toBe('list');
        expect(previousGuideStep('list')).toBe('sign');
        expect(nextGuideStep('form')).toBe('success');
        expect(nextGuideStep('imported')).toBe('imported');
        expect(previousGuideStep('start')).toBe('start');
        expect(previousGuideStep('verify')).toBe('list');
    });

    it('lists the real-money prerequisites with existing links only', () => {
        const titles = PRODUCTION_NEXT_STEPS.map(step => step.title).join('\n');
        for (const word of ['正式環境', '約定書', '模擬環境測試', 'CA 憑證']) expect(titles).toContain(word);
        for (const link of PRODUCTION_NEXT_STEPS.flatMap(step => step.links)) expect(link.url).toMatch(/^https:\/\/www\.sinotrade\.com\.tw\//);
    });
});

describe('apply guide native events', () => {
    it('accepts only well-formed, secret-free payloads', () => {
        expect(parseApplyGuideEvent('apply-guide:step', { step: 'form' })).toEqual({ kind: 'step', step: 'form' });
        expect(parseApplyGuideEvent('apply-guide:step', { step: 'evil' })).toBeNull();
        expect(parseApplyGuideEvent('apply-guide:step', { step: 'sign-h', sign: 'unsigned' })).toEqual({ kind: 'step', step: 'sign-h', sign: 'unsigned' });
        expect(parseApplyGuideEvent('apply-guide:step', { step: 'sign-s' })).toEqual({ kind: 'step', step: 'sign-s' });
        expect(parseApplyGuideEvent('apply-guide:step', { step: 'sign-s', sign: 'yes' })).toBeNull();
        expect(parseApplyGuideEvent('apply-guide:step', { step: 'list', sign: 'signed' })).toBeNull();
        expect(parseApplyGuideEvent('apply-guide:imported', { profileId: 'p1', name: 'ShioajiPro', duplicate: true }))
            .toEqual({ kind: 'imported', profileId: 'p1', name: 'ShioajiPro', duplicate: true });
        expect(parseApplyGuideEvent('apply-guide:imported', { profileId: 1 })).toBeNull();
        expect(parseApplyGuideEvent('apply-guide:import-failed', { message: '格式錯誤' }))
            .toEqual({ kind: 'import-failed', message: '格式錯誤' });
        for (const status of ['saved', 'failed', 'unknown'] as const) {
            expect(parseApplyGuideEvent('apply-guide:downloaded', { fileName: 'qrcode.png', status })).toEqual({ kind: 'downloaded', fileName: 'qrcode.png', status });
        }
        expect(parseApplyGuideEvent('apply-guide:downloaded', { fileName: 'qrcode.png', status: 'ok' })).toBeNull();
        expect(parseApplyGuideEvent('apply-guide:downloaded', { fileName: 'qrcode.png' })).toBeNull();
        expect(parseApplyGuideEvent('apply-guide:closed', null)).toEqual({ kind: 'closed' });
        expect(parseApplyGuideEvent('other', {})).toBeNull();
    });
});

describe('signing step copy', () => {
    it('says signing has no fixed order, is the user\'s own legal act and uses the certificate', () => {
        const sign = GUIDE_COPY.sign;
        expect(sign.title).toBe('簽署 API 約定書');
        expect(sign.lead).toContain('順序不限');
        expect(sign.lead).toContain('申請完金鑰再回來簽');
        expect(sign.lead).not.toMatch(/必須先|才能申請/);
        const all = sign.points.map(p => p.body).join('');
        expect(all).toContain('不會替你勾選或簽署');
        expect(all).toContain('電子憑證');
        // 簽完還要測試才能正式下單
        expect(all).toContain('模擬環境完成 API 測試');
    });
    it('links all three markets in the real-money prerequisites', () => {
        const step = PRODUCTION_NEXT_STEPS.find(s => s.title.includes('約定書'))!;
        expect(step.links.map(l => l.url)).toEqual([SIGNING_URLS.S.url, SIGNING_URLS.F.url, SIGNING_URLS.H.url]);
    });
});

describe('download step copy', () => {
    it('says the keys go straight into the app and no file lands in Downloads', () => {
        const point = GUIDE_COPY.success.points.find(p => p.target === 'download-env')!;
        expect(point.body).toContain('直接存進 App');
    });
});
