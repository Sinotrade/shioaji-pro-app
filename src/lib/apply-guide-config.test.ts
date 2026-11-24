import { describe, expect, it, vi } from 'vitest';
vi.mock('./tauri', () => ({ openExternalUrl: vi.fn() }));
import { APPLY_PAGE_RULES, GUIDE_COPY, GUIDE_ORDER, PRODUCTION_NEXT_STEPS, nextGuideStep, previousGuideStep, isApplyPageStep } from './apply-guide-config';
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
            for (const value of [rule.modalTitle, rule.pathPrefix]) if (value) expect(validText(value)).toBe(true);
        }
        const ids = new Set<string>();
        for (const target of APPLY_PAGE_RULES.targets) {
            expect(target.id).toMatch(ID);
            expect(ids.has(target.id)).toBe(false);
            ids.add(target.id);
            expect(isApplyPageStep(target.step)).toBe(true);
            expect(target.selector || target.text).toBeTruthy();
            for (const value of [target.selector, target.closest, target.text]) if (value) expect(validText(value)).toBe(true);
            // 只送原生殼認得的欄位（Rust 端 deny_unknown_fields）
            expect(Object.keys(target).every(key => ['id', 'step', 'selector', 'closest', 'text', 'auto'].includes(key))).toBe(true);
        }
    });

    it('detects open modals before falling back to the page path', () => {
        const order = APPLY_PAGE_RULES.steps.map(rule => rule.id);
        expect(order.slice(0, 3)).toEqual(['success', 'form', 'verify']);
        expect(order.at(-1)).toBe('login');
        expect(APPLY_PAGE_RULES.steps.at(-1)!.pathPrefix).toBe('/');
    });

    it('auto-highlights at most one target per step and every guide target exists on its step', () => {
        for (const step of APPLY_PAGE_RULES.steps) {
            expect(APPLY_PAGE_RULES.targets.filter(t => t.step === step.id && t.auto).length).toBeLessThanOrEqual(1);
        }
        for (const step of GUIDE_ORDER) {
            for (const point of GUIDE_COPY[step].points) {
                if (!point.target) continue;
                const target = APPLY_PAGE_RULES.targets.find(t => t.id === point.target);
                expect(target, `${step}: ${point.target}`).toBeDefined();
                expect(target!.step).toBe(step);
            }
        }
    });
});

describe('apply guide copy', () => {
    it('covers every page step and explains each form field', () => {
        for (const rule of APPLY_PAGE_RULES.steps) expect(GUIDE_COPY[rule.id].title).toBeTruthy();
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
        expect(GUIDE_ORDER).toEqual(['start', 'login', 'list', 'verify', 'form', 'success', 'imported']);
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
