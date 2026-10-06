// src/components/onboarding/live-player.test.tsx — 即時畫面按鈕：收合就斷串流、Esc 收合、調整大小。

import { StrictMode, createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIVE_DEFAULT_WIDTH, LivePlayer } from './live-player';

beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('window', Object.assign(new EventTarget(), { innerWidth: 1200, innerHeight: 800 }));
});
afterEach(() => vi.unstubAllGlobals());

const sized = { width: LIVE_DEFAULT_WIDTH, onWidthChange: vi.fn() };
const escape = () => Object.assign(new Event('keydown', { cancelable: true }), { key: 'Escape' });

describe('LivePlayer', () => {
    // 假的 <img>：記下 src 的接上與拿掉
    function fakeImage() {
        const img = {
            src: '',
            removeAttribute: vi.fn((name: string) => {
                if (name === 'src') img.src = '';
            }),
        };
        return img;
    }
    const player = (open: boolean, strict = false) => {
        const element = createElement(LivePlayer, { working: true, open, onOpenChange: vi.fn(), ...sized });
        return strict ? createElement(StrictMode, null, element) : element;
    };

    it.each([false, true])('streams only while open and drops the src before the image leaves (StrictMode: %s)', async (strict) => {
        const img = fakeImage();
        let view!: ReactTestRenderer;
        await act(async () => {
            view = create(player(false, strict), { createNodeMock: (element) => (element.type === 'img' ? img : null) });
        });
        expect(view.root.findAllByType('img')).toHaveLength(0);
        await act(async () => view.update(player(true, strict)));
        // StrictMode 先 cleanup 再重接：最後仍然接著串流
        expect(img.src).toBe('/api/sinopac-onboarding/live');
        await act(async () => view.update(player(false, strict)));
        expect(view.root.findAllByType('img')).toHaveLength(0);
        expect(img.src).toBe('');
    });

    it('collapses on Escape unless something else already handled it', async () => {
        const onOpenChange = vi.fn();
        await act(async () => {
            create(createElement(LivePlayer, { working: false, open: true, onOpenChange, ...sized }));
        });
        const handled = escape();
        handled.preventDefault();
        window.dispatchEvent(handled);
        // 注音組字中按 Esc 只是取消組字
        window.dispatchEvent(Object.assign(escape(), { isComposing: true }));
        expect(onOpenChange).not.toHaveBeenCalled();

        const fresh = escape();
        window.dispatchEvent(fresh);
        expect(onOpenChange).toHaveBeenCalledWith(false);
        expect(fresh.defaultPrevented).toBe(true);
    });

    it('hands focus back to the toggle when Escape closes the panel while focus is inside it', async () => {
        const focus = vi.fn();
        const inside = { panel: true };
        vi.stubGlobal('document', { activeElement: inside });
        const onOpenChange = vi.fn((open: boolean) => order.push(open ? 'open' : 'close'));
        const order: string[] = [];
        focus.mockImplementation(() => order.push('focus'));
        await act(async () => {
            create(createElement(LivePlayer, { working: false, open: true, onOpenChange, ...sized }), {
                createNodeMock: (element) => {
                    if (element.type === 'section') return { contains: (node: unknown) => node === inside };
                    if (element.type === 'button' && (element.props as { 'aria-label'?: string })['aria-label'] === '即時畫面') return { focus };
                    return null;
                },
            });
        });
        window.dispatchEvent(escape());
        expect(order).toEqual(['focus', 'close']); // 先交還焦點，面板才卸載

        // 焦點在面板外（例如表單）：不搶
        order.length = 0;
        vi.stubGlobal('document', { activeElement: { form: true } });
        window.dispatchEvent(escape());
        expect(order).toEqual(['close']);
    });

    it('ignores Escape while collapsed', async () => {
        const onOpenChange = vi.fn();
        await act(async () => {
            create(createElement(LivePlayer, { working: false, open: false, onOpenChange, ...sized }));
        });
        window.dispatchEvent(escape());
        expect(onOpenChange).not.toHaveBeenCalled();
    });

    describe('resize handle', () => {
        async function mountOpen(width: number, onWidthChange = vi.fn()) {
            let view!: ReactTestRenderer;
            await act(async () => {
                view = create(createElement(LivePlayer, { working: true, open: true, onOpenChange: vi.fn(), width, onWidthChange }));
            });
            return view;
        }
        async function handle(width: number) {
            const onWidthChange = vi.fn();
            const view = await mountOpen(width, onWidthChange);
            const button = view.root.find((node) => node.type === 'button' && node.props['aria-label'] === '調整即時畫面大小');
            return { button, onWidthChange };
        }
        const key = (name: string) => ({ key: name, preventDefault: vi.fn() });

        it('steps with the arrow keys: left/up grow, right/down shrink, within the window', async () => {
            const { button, onWidthChange } = await handle(400);
            for (const name of ['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown', 'Tab']) button.props.onKeyDown(key(name));
            expect(onWidthChange.mock.calls.map(([w]) => w)).toEqual([432, 432, 368, 368]);
        });

        it('clamps to the minimum and to what the window can hold at 16:10', async () => {
            const small = await handle(250);
            small.button.props.onKeyDown(key('ArrowDown'));
            expect(small.onWidthChange).toHaveBeenLastCalledWith(240);
            // 1200×800：寬最多 1168，高扣 140 後 660×1.6 = 1056
            const big = await handle(1050);
            big.button.props.onKeyDown(key('ArrowLeft'));
            expect(big.onWidthChange).toHaveBeenLastCalledWith(1056);
        });

        it('toggles between the default and a large size on a plain click (no dragging needed)', async () => {
            const small = await handle(LIVE_DEFAULT_WIDTH);
            small.button.props.onClick();
            expect(small.onWidthChange).toHaveBeenLastCalledWith(768);
            const large = await handle(768);
            large.button.props.onClick();
            expect(large.onWidthChange).toHaveBeenLastCalledWith(LIVE_DEFAULT_WIDTH);
        });

        it('still toggles back in a short window, where the large size is clamped below the midpoint', async () => {
            Object.assign(window, { innerWidth: 1280, innerHeight: 480 }); // 上限 (480-140)*1.6 = 544
            const grow = await handle(LIVE_DEFAULT_WIDTH);
            grow.button.props.onClick();
            expect(grow.onWidthChange).toHaveBeenLastCalledWith(544);
            const back = await handle(544);
            back.button.props.onClick();
            expect(back.onWidthChange).toHaveBeenLastCalledWith(LIVE_DEFAULT_WIDTH);
            // 從大視窗縮小後，state 比實際寬度大：也要能縮回去
            const stale = await handle(768);
            stale.button.props.onClick();
            expect(stale.onWidthChange).toHaveBeenLastCalledWith(LIVE_DEFAULT_WIDTH);
        });

        it('steps from the rendered width, not from a stale larger state', async () => {
            Object.assign(window, { innerWidth: 1280, innerHeight: 480 });
            const { button, onWidthChange } = await handle(768);
            button.props.onKeyDown(key('ArrowRight'));
            expect(onWidthChange).toHaveBeenLastCalledWith(512); // 544 - 32，不是 768 - 32 再夾回 544
        });

        it('binds the chosen width to the panel', async () => {
            const view = await mountOpen(400);
            expect(view.root.findByType('section').props.style['--live-w']).toBe('400px');
        });

        describe('dragging', () => {
            // 假把手：只要有 addEventListener／setPointerCapture，拖曳邏輯就跑得起來
            const down = (button: { props: any }, over: Record<string, unknown> = {}) => {
                const target = Object.assign(new EventTarget(), { setPointerCapture: vi.fn() });
                button.props.onPointerDown({ button: 0, isPrimary: true, clientX: 500, clientY: 500, pointerId: 1, currentTarget: target, ...over });
                const fire = (type: string, clientX: number, clientY: number, pointerId = 1) =>
                    target.dispatchEvent(Object.assign(new Event(type), { clientX, clientY, pointerId }));
                return { target, fire };
            };

            it('grows when dragged up-left and does not toggle on the click that ends the drag', async () => {
                const { button, onWidthChange } = await handle(LIVE_DEFAULT_WIDTH);
                const { target, fire } = down(button);
                fire('pointermove', 500, 500); // 沒超過門檻：不算拖曳
                expect(onWidthChange).not.toHaveBeenCalled();
                fire('pointermove', 400, 500);
                expect(onWidthChange).toHaveBeenLastCalledWith(484);
                fire('pointerup', 400, 500);
                button.props.onClick();
                expect(onWidthChange).toHaveBeenCalledTimes(1); // 拖曳結束的 click 不切換
                expect(target.setPointerCapture).toHaveBeenCalledWith(1);
                // 放開後不再追蹤
                fire('pointermove', 100, 500);
                expect(onWidthChange).toHaveBeenCalledTimes(1);
            });

            it('locks the axis once the drag starts, so crossing the diagonal does not jump', async () => {
                const { button, onWidthChange } = await handle(LIVE_DEFAULT_WIDTH);
                const { fire } = down(button);
                fire('pointermove', 490, 500); // 往左 10px：鎖 x 軸
                fire('pointermove', 490, 300); // 垂直拉 200px 也不改用 y 軸
                expect(onWidthChange.mock.calls.map(([w]) => w)).toEqual([394, 394]);
            });

            it('ignores a second finger and other pointers', async () => {
                const { button, onWidthChange } = await handle(LIVE_DEFAULT_WIDTH);
                const second = down(button, { isPrimary: false, pointerId: 2 });
                second.fire('pointermove', 300, 500, 2);
                expect(second.target.setPointerCapture).not.toHaveBeenCalled();
                expect(onWidthChange).not.toHaveBeenCalled();
                const first = down(button);
                first.fire('pointermove', 300, 500, 2); // 別的 pointer 的移動
                expect(onWidthChange).not.toHaveBeenCalled();
            });
        });
    });
});
