import { createElement } from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/tauri', () => ({ openExternalUrl: vi.fn() }));

import { ERROR_COPY, type OnboardingStopCode } from '../../../lib/sinopac-onboarding/errors';
import { createPlanForm, planFromForm } from '../../../lib/sinopac-onboarding/plan';
import { ONBOARDING_ERROR_CODES, type OnboardingPlan } from '../../../lib/sinopac-onboarding/types';
import { StoppedStep } from './StoppedStep';
import { buttonByText, buttonTexts, click, mount, textOf } from './steps-b.test-helpers';

const PLAN: OnboardingPlan = {
    ...planFromForm(createPlanForm(new Date(2026, 9, 5))),
    name: 'Shioaji-Pro',
    expiresOn: '2027-10-05',
};
const ALL_CODES: OnboardingStopCode[] = [...ONBOARDING_ERROR_CODES, 'MANUAL', 'KEY_UNSURE', 'GENERIC'];

async function setup(code: OnboardingStopCode, keyName: string | null = 'Shioaji-Pro', plan = PLAN) {
    const onRestart = vi.fn();
    const onClose = vi.fn();
    const view = await mount(createElement(StoppedStep, { code, plan, keyName, onRestart, onClose }));
    return { view, onRestart, onClose };
}

describe('StoppedStep recovery guidance', () => {
    it.each(ALL_CODES)('%s shows the fixed copy and the right way out', async (code) => {
        const copy = ERROR_COPY[code];
        const { view } = await setup(code);
        const text = textOf(view.root);
        expect(text).toContain(copy.title);
        expect(text).toContain(copy.message);

        const messageNode = view.root.findAll((n) => n.type === 'p' && textOf(n) === copy.message)[0]!;
        expect(messageNode.props.role).toBe(code === 'MANUAL' ? undefined : 'alert');

        const links = view.root.findAllByType('a').map((a) => a.props.href);
        expect(links.includes('https://www.sinotrade.com.tw/newweb/PythonAPIKey/')).toBe(copy.fallback);
        expect(text.includes('2. 新增 API Key 時，請這樣勾選')).toBe(copy.fallback);
        expect(text.includes('重新申請之前，請先檢查永豐金證券的 API Key 清單')).toBe(Boolean(copy.deleteKeyHint));

        const buttons = buttonTexts(view);
        if (copy.fallback) expect(buttons[0]).toBe('改用 API Key 登入');
        else expect(buttons).toEqual(['重新開始', '改用 API Key 登入']);
        expect(buttons).toHaveLength(2);
        for (const gone of ['遠端', '連接器', '雲端']) expect(text).not.toContain(gone);
        await act(async () => view.unmount());
    });

    it('for a possibly created key tells the user to find and delete it by name before retrying', async () => {
        const { view } = await setup('ONBOARDING_KEY_CAPTURE_FAILED', 'Shioaji-Pro');
        const text = textOf(view.root);
        expect(text).toContain('在 API 管理頁的清單找名稱為「Shioaji-Pro」的金鑰並刪除。');
        expect(text).toContain('沒刪除就重新申請，會多出一組用不到的金鑰');
        expect(buttonTexts(view)).toEqual(['改用 API Key 登入', '已確認並刪除，重新開始']);
        await act(async () => view.unmount());
    });

    it.each(['ONBOARDING_KEY_CAPTURE_FAILED', 'KEY_UNSURE'] as const)(
        '%s still shows the orphan-key warning when the key name is unknown',
        async (code) => {
            const { view } = await setup(code, null);
            const text = textOf(view.root);
            expect(text).toContain('重新申請之前，請先檢查永豐金證券的 API Key 清單');
            expect(text).toContain('找剛才這次申請建立的金鑰（看名稱與建立時間）');
            expect(text).not.toContain('找名稱為');
            await act(async () => view.unmount());
        },
    );

    it('does not show the delete hint for codes where no key can exist', async () => {
        const { view } = await setup('ONBOARDING_SESSION_EXPIRED');
        expect(textOf(view.root)).not.toContain('多出的金鑰');
        await act(async () => view.unmount());
    });

    it('lists the chosen plan in the manual checklist', async () => {
        const restricted: OnboardingPlan = {
            ...PLAN,
            permissions: { quote: true, account: true, trade: true, prod: true },
            accountTypes: ['stock', 'overseas'],
            ip: { mode: 'restricted', addresses: ['203.0.113.42', '203.0.113.43'] },
        };
        const { view } = await setup('MANUAL', null, restricted);
        const text = textOf(view.root);
        expect(text).toContain('Shioaji-Pro');
        expect(text).toContain('行情／資料、帳務、交易、正式環境');
        expect(text).toContain('證券戶、海外股票');
        expect(text).toContain('限制 IP：203.0.113.42、203.0.113.43');
        expect(text).toContain('2027-10-05');
        expect(text).toContain('「API Key 登入」分頁');
        await act(async () => view.unmount());

        const cloud = await setup('MANUAL', null);
        expect(textOf(cloud.view.root)).toContain('無限制 IP');
        expect(buttonTexts(cloud.view)).toEqual(['改用 API Key 登入', '回到第一步']);
        await act(async () => cloud.view.unmount());
    });

    it('wires restart and close to the matching buttons', async () => {
        const stop = await setup('ONBOARDING_ACCOUNT_LOCKED');
        await click(buttonByText(stop.view, '重新開始'));
        await click(buttonByText(stop.view, '改用 API Key 登入'));
        expect(stop.onRestart).toHaveBeenCalledOnce();
        expect(stop.onClose).toHaveBeenCalledOnce();
        await act(async () => stop.view.unmount());

        const manual = await setup('MANUAL');
        await click(buttonByText(manual.view, '改用 API Key 登入'));
        await click(buttonByText(manual.view, '回到第一步'));
        expect(manual.onClose).toHaveBeenCalledOnce();
        expect(manual.onRestart).toHaveBeenCalledOnce();
        await act(async () => manual.view.unmount());
    });

    it('falls back to the generic copy for a code it does not know', async () => {
        const { view } = await setup('SERVER_SAID_SOMETHING' as OnboardingStopCode);
        const text = textOf(view.root);
        expect(text).toContain(ERROR_COPY.GENERIC.title);
        expect(text).not.toContain('SERVER_SAID_SOMETHING');
        await act(async () => view.unmount());
    });
});
