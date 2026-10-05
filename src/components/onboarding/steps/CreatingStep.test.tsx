import { createElement } from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../../lib/tauri', () => ({ openExternalUrl: vi.fn() }));

import { CreatingStep } from './CreatingStep';
import {
    beforeUnloadEvent,
    buttonTexts,
    click,
    keydownEvent,
    mount,
    stubBrowser,
    textOf,
} from './steps-b.test-helpers';

afterEach(() => vi.unstubAllGlobals());

async function setup(props: { resumed?: boolean; gaveUp?: boolean } = {}) {
    const browser = stubBrowser();
    const onCancel = vi.fn();
    const view = await mount(createElement(CreatingStep, { resumed: false, gaveUp: false, onCancel, ...props }));
    return { ...browser, view, onCancel };
}

describe('CreatingStep', () => {
    it('says the key is being created, once only, and offers no retry or resubmit control', async () => {
        const { view, onCancel } = await setup();
        const text = textOf(view.root);
        expect(text).toContain('正在建立 API Key');
        expect(text).toContain('請不要關閉或重新整理這個頁面');
        expect(text).toContain('建立金鑰只會送出一次，不會自動重試');
        expect(buttonTexts(view)).toEqual([]);
        for (const gone of ['遠端', '連接器', '雲端']) expect(text).not.toContain(gone);
        expect(text).toContain('寫入本機設定，並關閉瀏覽器');
        expect(onCancel).not.toHaveBeenCalled();
        await act(async () => view.unmount());
    });

    it('explains that a restored session can only wait', async () => {
        const { view } = await setup({ resumed: true });
        expect(textOf(view.root)).toContain('頁面重新整理過，正在等伺服器完成上一次送出的建立');
        await act(async () => view.unmount());
    });

    it('after giving up shows only a cancel button and warns about a possible duplicate key', async () => {
        const { view, onCancel } = await setup({ gaveUp: true });
        const text = textOf(view.root);
        expect(text).toContain('為避免重複建立金鑰，我們不會自動再送一次');
        expect(text).toContain('確認有沒有多出一組金鑰');
        expect(buttonTexts(view)).toEqual(['取消並離開']);
        expect(view.root.findAllByProps({ role: 'alert' })).not.toHaveLength(0);
        await click(view.root.findByType('button'));
        expect(onCancel).toHaveBeenCalledOnce();
        await act(async () => view.unmount());
    });

    it('blocks a reload while its own create request is in flight, but not when restored or given up', async () => {
        const live = await setup();
        const event = beforeUnloadEvent();
        live.win.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
        // 只攔重新整理；Esc 與上一頁由父層的對話框負責。
        const esc = keydownEvent('Escape');
        live.win.dispatchEvent(esc);
        expect(esc.defaultPrevented).toBe(false);
        expect(live.history.pushState).not.toHaveBeenCalled();
        await act(async () => live.view.unmount());

        for (const props of [{ resumed: true }, { gaveUp: true }]) {
            const idle = await setup(props);
            const free = beforeUnloadEvent();
            idle.win.dispatchEvent(free);
            expect(free.defaultPrevented).toBe(false);
            await act(async () => idle.view.unmount());
        }
    });
});
