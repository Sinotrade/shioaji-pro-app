import { createElement, useRef, type RefObject } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantFab } from './assistant-fab';
import { FAB_SIZE } from './assistant-fab.css';

let view: ReactTestRenderer | undefined;
beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('window', Object.assign(new EventTarget(), { innerWidth: 1200 }));
});
afterEach(async () => {
    if (view) { await act(async () => view!.unmount()); view = undefined; }
    vi.unstubAllGlobals();
});

// 每個內容區元素有自己的位置（test renderer 的節點 mock 依 data-rect 給）
const rects: Record<string, DOMRect> = {
    download: { left: 0, top: 0, right: 500, bottom: 700, width: 500, height: 700 } as DOMRect,
    done: { left: 10, top: 20, right: 410, bottom: 620, width: 400, height: 600 } as DOMRect,
};

function Harness({ step }: { step: 'download' | 'done' }) {
    const ref = useRef<HTMLDivElement>(null);
    // 和 ApplyGuide 一樣：不同步驟是不同的 JSX 分支，換步驟時內容區換成新元素
    const body = step === 'download'
        ? createElement('section', { key: 'a' }, createElement('div', { ref, 'data-rect': 'download' }))
        : createElement('article', { key: 'b' }, createElement('div', { ref, 'data-rect': 'done' }));
    return createElement('main', null, body,
        createElement(AssistantFab, { open: false, onOpenChange: () => {}, docked: true, anchorRef: ref as RefObject<HTMLElement | null>, children: null }));
}

describe('AssistantFab docked anchor', () => {
    it('follows the guide body when the step swaps in a new element', async () => {
        const options = {
            createNodeMock: (el: { props: unknown }) => {
                const key = (el.props as Record<string, unknown>)['data-rect'];
                const rect = (typeof key === 'string' && rects[key]) || ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 } as DOMRect);
                return { getBoundingClientRect: () => rect };
            },
        };
        await act(async () => { view = create(createElement(Harness, { step: 'download' }), options); });
        const fab = () => view!.root.findAll(n => n.type === 'button' && n.props['aria-expanded'] === false)[0]!;
        expect(fab().props.style).toMatchObject({ left: 500 - FAB_SIZE - 16, top: 700 - FAB_SIZE - 16 });
        await act(async () => { view!.update(createElement(Harness, { step: 'done' })); });
        expect(fab().props.style).toMatchObject({ left: 410 - FAB_SIZE - 16, top: 620 - FAB_SIZE - 16 });
    });
});
