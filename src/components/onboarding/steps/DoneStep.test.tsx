import { createElement } from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../lib/tauri', () => ({ openExternalUrl: vi.fn() }));

import type { Readiness } from '../../../lib/sinopac-onboarding/readiness';
import type { OnboardingResult } from '../../../lib/sinopac-onboarding/types';
import { DoneStep } from './DoneStep';
import * as s from './steps-b.css';
import {
    beforeUnloadEvent,
    buttonByLabel,
    buttonByText,
    buttonTexts,
    change,
    click,
    dump,
    keydownEvent,
    mount,
    stubBrowser,
    textOf,
} from './steps-b.test-helpers';

// 測試用假值：不是也不像任何真實憑證。
const KEYS = { apiKey: 'fake-api', secretKey: 'fake-secret' };
const RESULT: OnboardingResult = {
    apiKeyLast4: '1234',
    expiresOn: '2027-10-05',
    permissions: ['quote', 'account', 'prod'],
    accountLabels: ['證券 ••••5678'],
};
const NOTICE = 'Secret Key 只會顯示這一次，請先勾選「我已經複製並安全保存」再繼續。';

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

async function setup(props: Partial<Parameters<typeof DoneStep>[0]> = {}) {
    const browser = stubBrowser();
    const onFinish = vi.fn();
    const view = await mount(createElement(DoneStep, { result: RESULT, revealed: KEYS, onFinish, ...props }));
    const confirm = () => view.root.findByProps({ type: 'checkbox' });
    const finishButton = () => buttonByText(view, '進入 Shioaji Pro');
    return { ...browser, view, onFinish, confirm, finishButton };
}

describe('DoneStep secret handling', () => {
    it('keeps both keys out of the rendered tree until they are revealed', async () => {
        const { view } = await setup();
        const html = dump(view);
        expect(html).not.toContain(KEYS.apiKey);
        expect(html).not.toContain(KEYS.secretKey);
        expect(html).toContain('•'.repeat(44));
        expect(view.root.findAllByProps({ 'aria-label': 'Secret Key（已隱藏）' })).not.toHaveLength(0);
        await act(async () => view.unmount());
    });

    it('reveals and hides each key on its own and never puts a value in an aria-label', async () => {
        const { view } = await setup();
        await click(buttonByLabel(view, '顯示 Secret Key'));
        expect(dump(view)).toContain(KEYS.secretKey);
        expect(dump(view)).not.toContain(KEYS.apiKey);
        expect(buttonByLabel(view, '隱藏 Secret Key').props['aria-pressed']).toBe(true);
        await click(buttonByLabel(view, '顯示 API Key'));
        expect(dump(view)).toContain(KEYS.apiKey);
        await click(buttonByLabel(view, '隱藏 Secret Key'));
        expect(dump(view)).not.toContain(KEYS.secretKey);
        const labels = view.root
            .findAll((node) => typeof node.props['aria-label'] === 'string')
            .map((node) => node.props['aria-label'] as string);
        for (const label of labels) {
            expect(label).not.toContain(KEYS.apiKey);
            expect(label).not.toContain(KEYS.secretKey);
        }
        await act(async () => view.unmount());
    });

    it('copies the real value even while it is masked, and confirms with 已複製', async () => {
        const { view, writeText } = await setup();
        await click(buttonByLabel(view, '複製 Secret Key'));
        expect(writeText).toHaveBeenCalledExactlyOnceWith(KEYS.secretKey);
        expect(textOf(buttonByLabel(view, '複製 Secret Key'))).toBe('已複製');
        expect(dump(view)).not.toContain(KEYS.secretKey);
        await click(buttonByLabel(view, '複製 API Key'));
        expect(writeText).toHaveBeenLastCalledWith(KEYS.apiKey);
        await act(async () => view.unmount());
    });

    it('tells the user to copy by hand when the clipboard is refused', async () => {
        const { view, writeText } = await setup();
        writeText.mockRejectedValue(new Error('denied'));
        await click(buttonByLabel(view, '複製 API Key'));
        expect(dump(view)).toContain('瀏覽器不允許自動複製');
        await act(async () => view.unmount());
    });

    it('shows only the last four digits of the key and the plan summary', async () => {
        const { view } = await setup();
        const text = textOf(view.root);
        expect(text).toContain('••••••••1234');
        expect(text).toContain('2027-10-05');
        expect(text).toContain('行情／資料、帳務、正式環境');
        expect(text).toContain('證券 ••••5678');
        await act(async () => view.unmount());
    });
});

describe('DoneStep close protection', () => {
    it('cannot be finished until the user confirms the keys are saved', async () => {
        const { view, onFinish, confirm, finishButton } = await setup();
        expect(finishButton().props.disabled).toBe(true);
        await click(finishButton());
        expect(onFinish).not.toHaveBeenCalled();
        expect(textOf(view.root)).toContain('勾選上面的確認後才能進入。');

        await change(confirm(), { checked: true });
        expect(finishButton().props.disabled).toBe(false);
        await click(finishButton());
        expect(onFinish).toHaveBeenCalledOnce();
        await act(async () => view.unmount());
    });

    it('blocks reload (beforeunload) until saved, then lets it through', async () => {
        const { win, view, confirm } = await setup();
        const locked = beforeUnloadEvent();
        win.dispatchEvent(locked);
        expect(locked.defaultPrevented).toBe(true);
        expect((locked as unknown as { returnValue: unknown }).returnValue).toBe('');

        await change(confirm(), { checked: true });
        const free = beforeUnloadEvent();
        win.dispatchEvent(free);
        expect(free.defaultPrevented).toBe(false);
        await act(async () => view.unmount());
    });

    it('swallows Esc while unsaved and explains why, then stops intercepting once saved', async () => {
        const { win, view, confirm } = await setup();
        // 其他 Esc 監聽（例如全域快捷鍵）仍要收得到事件，並看見 defaultPrevented。
        const seen: boolean[] = [];
        win.addEventListener('keydown', (event) => seen.push(event.defaultPrevented));
        const esc = keydownEvent('Escape');
        await act(async () => {
            win.dispatchEvent(esc);
        });
        expect(esc.defaultPrevented).toBe(true);
        expect(seen).toEqual([true]);
        expect(textOf(view.root)).toContain(NOTICE);

        const other = keydownEvent('a');
        win.dispatchEvent(other);
        expect(other.defaultPrevented).toBe(false);

        await change(confirm(), { checked: true });
        expect(textOf(view.root)).not.toContain(NOTICE);
        const free = keydownEvent('Escape');
        win.dispatchEvent(free);
        expect(free.defaultPrevented).toBe(false);
        await act(async () => view.unmount());
    });

    it('absorbs the browser back button with a history entry while unsaved', async () => {
        const { win, history, view, confirm } = await setup();
        expect(history.pushState).toHaveBeenCalledTimes(1);
        await act(async () => {
            win.dispatchEvent(new Event('popstate'));
        });
        expect(history.pushState).toHaveBeenCalledTimes(2);
        expect(textOf(view.root)).toContain(NOTICE);

        await change(confirm(), { checked: true });
        await act(async () => {
            win.dispatchEvent(new Event('popstate'));
        });
        expect(history.pushState).toHaveBeenCalledTimes(2);
        await act(async () => view.unmount());
    });

    it('removes every guard when it unmounts', async () => {
        const { win, view } = await setup();
        await act(async () => view.unmount());
        const unload = beforeUnloadEvent();
        const esc = keydownEvent('Escape');
        win.dispatchEvent(unload);
        win.dispatchEvent(esc);
        expect(unload.defaultPrevented).toBe(false);
        expect(esc.defaultPrevented).toBe(false);
    });

    it('reports the lock state to the parent so it can guard its own close controls', async () => {
        const onLockedChange = vi.fn();
        const { view, confirm } = await setup({ onLockedChange });
        expect(onLockedChange).toHaveBeenLastCalledWith(true);
        await change(confirm(), { checked: true });
        expect(onLockedChange).toHaveBeenLastCalledWith(false);
        await change(confirm(), { checked: false });
        expect(onLockedChange).toHaveBeenLastCalledWith(true);
        await act(async () => view.unmount());
        expect(onLockedChange).toHaveBeenLastCalledWith(false);
    });
});

describe('DoneStep onFinish', () => {
    it('waits for an async onFinish and ignores a second press meanwhile', async () => {
        let release!: () => void;
        const onFinish = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
        const { view, confirm, finishButton } = await setup({ onFinish });
        await change(confirm(), { checked: true });
        await click(finishButton());
        expect(finishButton().props.disabled).toBe(true);
        await click(finishButton());
        expect(onFinish).toHaveBeenCalledOnce();
        await act(async () => release());
        // 完成後不能再按一次。
        expect(finishButton().props.disabled).toBe(true);
        await act(async () => view.unmount());
    });

    it('keeps the keys on screen and the guards armed when onFinish rejects, without echoing the error', async () => {
        const onFinish = vi.fn().mockRejectedValue(new Error('disk full: /secret/path'));
        const { win, view, confirm, finishButton } = await setup({ onFinish });
        await click(buttonByLabel(view, '顯示 Secret Key'));
        await change(confirm(), { checked: true });
        await click(finishButton());

        const html = dump(view);
        expect(html).toContain(KEYS.secretKey);
        expect(html).not.toContain('disk full');
        expect(textOf(view.root)).toContain('沒有完成。金鑰仍保留在這個畫面');
        expect(confirm().props.checked).toBe(false);
        expect(finishButton().props.disabled).toBe(true);
        const unload = beforeUnloadEvent();
        win.dispatchEvent(unload);
        expect(unload.defaultPrevented).toBe(true);
        await act(async () => view.unmount());
    });
});

describe('DoneStep without a revealed secret', () => {
    it('shows no key panel, installs no guard and can be closed straight away', async () => {
        const onLockedChange = vi.fn();
        const { win, history, view, onFinish } = await setup({ revealed: null, onLockedChange });
        const html = dump(view);
        expect(html).not.toContain('金鑰（只顯示一次）');
        expect(textOf(view.root)).toContain('Secret Key 不會顯示在畫面上');
        const unload = beforeUnloadEvent();
        const esc = keydownEvent('Escape');
        win.dispatchEvent(unload);
        win.dispatchEvent(esc);
        expect(unload.defaultPrevented).toBe(false);
        expect(esc.defaultPrevented).toBe(false);
        expect(history.pushState).not.toHaveBeenCalled();
        expect(onLockedChange).toHaveBeenLastCalledWith(false);

        const finish = buttonByText(view, '進入 Shioaji Pro');
        expect(finish.props.disabled).toBe(false);
        await click(finish);
        expect(onFinish).toHaveBeenCalledOnce();
        await act(async () => view.unmount());
    });
});

describe('DoneStep when the parent could not store the keys', () => {
    it('says so and tells the user where to paste them', async () => {
        const { view } = await setup({ saveFailed: true });
        const text = textOf(view.root);
        expect(text).toContain('金鑰已建立，但沒有儲存');
        expect(text).toContain('「API Key 登入」分頁');
        expect(text).toContain('請立即複製');
        await act(async () => view.unmount());
    });

    it('otherwise says the keys are already stored', async () => {
        const { view } = await setup();
        expect(textOf(view.root)).toContain('API Key 申請成功');
        expect(textOf(view.root)).toContain('寫入本機設定');
        await act(async () => view.unmount());
    });
});

describe('DoneStep .env location', () => {
    const PATH = '/work/shioaji-pro-app/.env';
    const SAVED_NOTE = `已寫入 ${PATH}`;

    it('says where the keys were written, and keeps the secret and the export buttons out of the DOM', async () => {
        const { view } = await setup({ savedPath: PATH });
        expect(textOf(view.root)).toContain(SAVED_NOTE);
        const html = dump(view);
        expect(html).not.toContain(KEYS.apiKey);
        expect(html).not.toContain(KEYS.secretKey);
        expect(view.root.findAllByType('button').map(textOf).join('|')).not.toContain('.env');
        await act(async () => view.unmount());
    });

    it('shows the path without a revealed secret too, and says nothing when no path is known', async () => {
        const hidden = await setup({ savedPath: PATH, revealed: null });
        expect(textOf(hidden.view.root)).toContain(SAVED_NOTE);
        await act(async () => hidden.view.unmount());
        const unknown = await setup();
        expect(textOf(unknown.view.root)).not.toContain('已寫入');
        await act(async () => unknown.view.unmount());
    });

    it('never claims a location when the keys were not saved', async () => {
        const { view } = await setup({ saveFailed: true, savedPath: PATH });
        expect(textOf(view.root)).not.toContain('已寫入');
        expect(dump(view)).not.toContain(PATH);
        await act(async () => view.unmount());
    });
});

describe('DoneStep .env export after a failed save', () => {
    const ENV_TEXT = `SJ_API_KEY=${KEYS.apiKey}\nSJ_SEC_KEY=${KEYS.secretKey}\n`;

    it('builds the two .env lines only on click, and the keys stay masked on screen', async () => {
        const { view, writeText } = await setup({ saveFailed: true });
        expect(dump(view)).not.toContain(KEYS.apiKey);
        expect(dump(view)).not.toContain(KEYS.secretKey);
        expect(writeText).not.toHaveBeenCalled();

        await click(buttonByText(view, '複製成 .env 兩行'));
        expect(writeText).toHaveBeenCalledExactlyOnceWith(ENV_TEXT);
        expect(textOf(buttonByText(view, '已複製 .env 兩行'))).toBe('已複製 .env 兩行');
        expect(textOf(view.root)).toContain('已複製 .env 兩行');
        expect(dump(view)).not.toContain(KEYS.secretKey);
        await act(async () => view.unmount());
    });

    it('tells the user to copy by hand when the clipboard refuses the .env lines', async () => {
        const { view, writeText } = await setup({ saveFailed: true });
        writeText.mockRejectedValue(new Error('denied'));
        await click(buttonByText(view, '複製成 .env 兩行'));
        expect(textOf(view.root)).toContain('瀏覽器不允許自動複製');
        expect(textOf(buttonByText(view, '複製成 .env 兩行'))).toBe('複製成 .env 兩行');
        await act(async () => view.unmount());
    });

    it('downloads a same-origin blob named .env and revokes the object URL afterwards', async () => {
        const link = { href: '', download: '', click: vi.fn() };
        const createElement = vi.fn(() => link);
        vi.stubGlobal('document', { createElement });
        const blobs: Blob[] = [];
        const create = vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
            blobs.push(blob as Blob);
            return 'blob:fake-url';
        });
        const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
        const { view } = await setup({ saveFailed: true });
        expect(create).not.toHaveBeenCalled();

        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        await click(buttonByText(view, '下載 .env 檔'));
        expect(createElement).toHaveBeenCalledExactlyOnceWith('a');
        expect(link.href).toBe('blob:fake-url');
        expect(link.download).toBe('.env');
        expect(link.click).toHaveBeenCalledOnce();
        expect(blobs).toHaveLength(1);
        expect(blobs[0]?.type).toBe('text/plain');
        expect(await blobs[0]?.text()).toBe(ENV_TEXT);
        expect(revoke).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1000);
        expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:fake-url');
        expect(dump(view)).not.toContain(KEYS.secretKey);
        await act(async () => view.unmount());
    });

    it('offers no export buttons without a revealed secret, and keeps the confirm guard intact', async () => {
        const none = await setup({ saveFailed: true, revealed: null });
        expect(buttonTexts(none.view).join('|')).not.toContain('.env');
        await act(async () => none.view.unmount());

        const { view, onFinish, confirm, finishButton } = await setup({ saveFailed: true });
        expect(finishButton().props.disabled).toBe(true);
        await click(buttonByText(view, '複製成 .env 兩行'));
        expect(finishButton().props.disabled).toBe(true);
        await change(confirm(), { checked: true });
        await click(finishButton());
        expect(onFinish).toHaveBeenCalledOnce();
        await act(async () => view.unmount());
    });
});

describe('DoneStep saved view', () => {
    it('shows the written path and a single primary action, with no key panel or notice', async () => {
        const { view, onFinish } = await setup({ revealed: null, savedPath: '/work/.env' });
        expect(textOf(view.root)).toContain('已寫入 /work/.env');
        expect(buttonTexts(view)).toEqual(['進入 Shioaji Pro']);
        await click(buttonByText(view, '進入 Shioaji Pro'));
        expect(onFinish).toHaveBeenCalledOnce();
        await act(async () => view.unmount());
    });
});

describe('DoneStep salvage view', () => {
    it('reminds the user to delete the downloaded .env and keeps each value on its own line above its buttons', async () => {
        const { view } = await setup({ saveFailed: true });
        expect(textOf(view.root)).toContain('請刪除下載的檔案');
        // 值與按鈕分兩行：值的容器裡不放按鈕，窄螢幕才不會被擠成一小條。
        const value = view.root.findByProps({ 'aria-label': 'Secret Key（已隱藏）' });
        expect(value.findAllByType('button')).toHaveLength(0);
        expect(value.parent!.findAllByType('button').length).toBeGreaterThan(0);
        await act(async () => view.unmount());
    });

    it('does not show the delete reminder in the normal view', async () => {
        const { view } = await setup();
        expect(textOf(view.root)).not.toContain('請刪除下載的檔案');
        await act(async () => view.unmount());
    });
});

describe('DoneStep account readiness', () => {
    const STOCK_SIGN = 'https://www.sinotrade.com.tw/newweb/signCenter/S_openAPI/';
    const FUTURES_SIGN = 'https://www.sinotrade.com.tw/newweb/signCenter/F_openApi/';
    const READY = '帳戶已開通 API 下單，正式環境可以使用。';
    const UNKNOWN = '目前無法確認帳戶是否已開通。進入 Shioaji Pro 後，可在右上角「伺服器」面板按「檢查目前帳戶／CA」確認';
    const links = (view: Awaited<ReturnType<typeof setup>>['view']) =>
        view.root.findAllByType('a').map((link) => link.props.href as string);
    const todoLists = (view: Awaited<ReturnType<typeof setup>>['view']) =>
        view.root.findAll((node) => node.type === 'ul' && node.props.className === s.list);

    it('says it is checking until the answer arrives, and asks only once per mount', async () => {
        let answer!: (readiness: Readiness) => void;
        const checkReadiness = vi.fn(() => new Promise<Readiness>((resolve) => (answer = resolve)));
        const { view, onFinish } = await setup({ checkReadiness });
        const status = view.root.findAll((node) => node.props.role === 'status').map(textOf);
        expect(status).toContain('正在確認帳戶是否已開通 API 下單…');
        expect(textOf(view.root)).not.toContain(UNKNOWN);
        // 父層重新 render 時給了新的函式，也不會再查一次。
        const again = vi.fn(async (): Promise<Readiness> => ({ kind: 'unknown' }));
        await act(async () =>
            view.update(createElement(DoneStep, { result: RESULT, revealed: KEYS, onFinish, checkReadiness: again })),
        );
        await act(async () => answer({ kind: 'ready' }));
        expect(textOf(view.root)).not.toContain('正在確認');
        expect(textOf(view.root)).toContain(READY);
        expect(checkReadiness).toHaveBeenCalledOnce();
        expect(again).not.toHaveBeenCalled();
        await act(async () => view.unmount());
    });

    it('shows the ok banner and no to-do list once the accounts are ready', async () => {
        const { view } = await setup({ revealed: null, checkReadiness: async () => ({ kind: 'ready' }) });
        const text = textOf(view.root);
        expect(text).toContain(READY);
        expect(text).not.toContain('接下來');
        expect(text).not.toContain('還有帳戶尚未開通');
        expect(text).not.toContain('模擬登入與下單測試');
        expect(todoLists(view)).toHaveLength(0);
        expect(links(view)).toEqual([]);
        await act(async () => view.unmount());
    });

    it('lists each account that is not ready with its own signing page', async () => {
        const checkReadiness = async (): Promise<Readiness> => ({
            kind: 'pending',
            items: [
                { product: 'stock', label: '證券 ••••5678' },
                { product: 'futures', label: '期權 ••••4321' },
            ],
        });
        const { view } = await setup({ checkReadiness });
        expect(textOf(view.root)).toContain('還有帳戶尚未開通');
        const items = view.root.findAllByType('li').map(textOf);
        expect(items).toContain(
            '證券 ••••5678：請先簽署證券 API 約定書，再完成模擬登入與下單測試（週一至週五 08:00 到 20:00）。完成後正式環境才能使用。',
        );
        expect(items).toContain(
            '期權 ••••4321：請先簽署期貨／選擇權 API 約定書，再完成模擬登入與下單測試（週一至週五 08:00 到 20:00）。完成後正式環境才能使用。',
        );
        expect(links(view)).toEqual([STOCK_SIGN, FUTURES_SIGN]);
        expect(textOf(view.root)).not.toContain(READY);
        await act(async () => view.unmount());
    });

    it.each([
        ['without a check', undefined],
        ['when the check cannot tell', async (): Promise<Readiness> => ({ kind: 'unknown' })],
        ['when the check itself fails', () => Promise.reject(new Error('offline'))],
    ])('points to the server panel %s', async (_name, checkReadiness) => {
        const { view } = await setup({ checkReadiness });
        const text = textOf(view.root);
        expect(text).toContain(UNKNOWN);
        expect(text).not.toContain('正在確認');
        expect(text).not.toContain(READY);
        expect(links(view)).toEqual([]);
        await act(async () => view.unmount());
    });

    it('keeps only the .env step in the to-do section when saving failed', async () => {
        const { view } = await setup({ saveFailed: true, checkReadiness: async () => ({ kind: 'ready' }) });
        expect(textOf(view.root)).toContain('接下來要做的事');
        expect(textOf(view.root)).toContain(READY);
        const lists = todoLists(view);
        expect(lists).toHaveLength(1);
        expect(lists[0]!.findAllByType('li').map(textOf)).toEqual([
            '用「複製成 .env 兩行」或「下載 .env 檔」把兩個值放進專案資料夾的 .env，或之後填進「API Key 登入」分頁。',
        ]);
        await act(async () => view.unmount());
    });
});
