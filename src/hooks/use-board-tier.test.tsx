import { createElement, useRef } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BOARD_TIERS, RAIL_TIERS, type BoardTier } from '../lib/board-tier';

let root: ReactTestRenderer | undefined;
let useBoardTier: typeof import('./use-board-tier').useBoardTier;
let result: ReturnType<typeof useBoardTier>;
let width: number;
let rootPx: number;
let priceWidth: number;
let reads: number;
let board: HTMLElement;
interface FakeLeaf { textContent: string; clientWidth: number; scrollWidth: number; children: never[]; childNodes: { nodeType: number; textContent: string }[]; closest: () => unknown }
let price: FakeLeaf & { getBoundingClientRect: () => { width: number } };
let statistics: FakeLeaf;
let leaves: FakeLeaf[];
let storage: Map<string, string>;
let storageHandler: (event: { key: string | null }) => void;
let fontHandlers: Map<string, () => void>;
let fontAdd: ReturnType<typeof vi.fn>;
let fontRemove: ReturnType<typeof vi.fn>;
let frames: Map<number, FrameRequestCallback>;
let observers: { fire: () => void; disconnect: ReturnType<typeof vi.fn> }[];
let needs: Partial<Record<BoardTier, number>>;
const modeKey = 'sj-stock-board-mode';

beforeEach(async () => {
    vi.resetModules();
    width = 600; rootPx = 16; priceWidth = 200; reads = 0;
    needs = { wide: 600, mid: 450, rail: 650, railMid: 500, railLow: 480 };
    storage = new Map(); frames = new Map(); observers = []; fontHandlers = new Map();
    let frameId = 0;
    fontAdd = vi.fn((name: string, handler: () => void) => fontHandlers.set(name, handler));
    fontRemove = vi.fn((name: string, handler: () => void) => { if (fontHandlers.get(name) === handler) fontHandlers.delete(name); });
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
    vi.stubGlobal('window', { addEventListener: (name: string, handler: typeof storageHandler) => { if (name === 'storage') storageHandler = handler; } });
    vi.stubGlobal('document', { documentElement: {}, fonts: { ready: Promise.resolve(), addEventListener: fontAdd, removeEventListener: fontRemove } });
    vi.stubGlobal('getComputedStyle', () => ({ fontSize: `${rootPx}px`, paddingRight: '10px' }));
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    vi.stubGlobal('ResizeObserver', class {
        observe = vi.fn();
        disconnect = vi.fn();
        constructor(callback: () => void) { observers.push({ fire: callback, disconnect: this.disconnect }); }
    });
    const textNode = (value: string) => ({ nodeType: 3, textContent: value });
    price = { textContent: '2,420', children: [], get childNodes() { return [textNode(this.textContent)]; }, closest: () => null, clientWidth: 200, scrollWidth: 200, getBoundingClientRect: () => ({ width: priceWidth }) };
    statistics = { textContent: '上漲99', children: [], get childNodes() { return [textNode(this.textContent)]; }, closest: () => null, clientWidth: 100, scrollWidth: 100 };
    leaves = [price, statistics];
    const fake = { dataset: {} as Record<string, string>, style: { paddingRight: '' }, children: [price, statistics], firstElementChild: price,
        querySelectorAll: () => leaves, childNodes: [], closest: () => null,
        parentElement: { clientHeight: 1000 }, previousElementSibling: { getBoundingClientRect: () => ({ height: 20 }), previousElementSibling: null } };
    Object.defineProperties(fake, {
        clientWidth: { get: () => width },
        scrollWidth: { get: () => { reads++; return Math.max(width, (needs[fake.dataset.tier as BoardTier] ?? 0) + (parseFloat(fake.style.paddingRight || '10') - 10)); } },
        offsetHeight: { get: () => fake.dataset.tier === 'strip' ? 25 : 50 },
    });
    board = fake as unknown as HTMLElement;
    ({ useBoardTier } = await import('./use-board-tier'));
});

afterEach(() => {
    if (root) act(() => root!.unmount());
    root = undefined;
    vi.unstubAllGlobals();
});

function Probe({ signature = 'initial', tiers = BOARD_TIERS }: { signature?: string; tiers?: readonly BoardTier[] }) {
    const ref = useRef<HTMLElement>(board);
    result = useBoardTier(ref, modeKey, tiers);
    return createElement('div', { 'data-tier': result.tier, 'data-probe-render': signature });
}
async function mount(tiers = BOARD_TIERS) {
    await act(async () => { root = create(createElement(Probe, { tiers })); });
    flushFrames();
}
function flushFrames() {
    act(() => {
        const scheduled = [...frames.values()];
        frames.clear();
        scheduled.forEach(callback => callback(0));
    });
}
function resize(nextWidth: number) {
    width = nextWidth;
    act(() => observers.at(-1)!.fire());
    flushFrames();
}

describe('useBoardTier 的瀏覽器接線與量測', () => {
    it('尺寸改變時回傳值與 data-tier 同步，卸載清除屬性、留白與 observer', async () => {
        await mount();
        expect([result.tier, board.dataset.tier]).toEqual(['wide', 'wide']);
        resize(590);
        expect([result.tier, board.dataset.tier]).toEqual(['mid', 'mid']);
        const observer = observers.at(-1)!;
        act(() => root!.unmount()); root = undefined;
        expect(board.dataset.tier).toBeUndefined();
        expect(board.style.paddingRight).toBe('');
        expect(observer.disconnect).toHaveBeenCalledOnce();
        expect(frames.size).toBe(0);
    });

    it.each([{ root: 16, price: 200, slack: 80 }, { root: 100, price: 20, slack: 90 }])(
        '升級取根字級與兩個價格字寬的較大緩衝：$slack px', async sample => {
            // 根字級 * 0.9，或 2 * 現價寬度 / 5 字；假 DOM 只模擬量測決策。
            rootPx = sample.root; priceWidth = sample.price;
            await mount();
            resize(598); // 量測契約允許 1px 捨入差，需超過它才算溢出。
            expect(result.tier).toBe('mid');
            resize(600 + sample.slack - 2);
            expect(result.tier).toBe('mid');
            resize(600 + sample.slack);
            expect(result.tier).toBe('wide');
            expect(board.style.paddingRight).toBe('');
        },
    );

    it('手動展開只選完整 rail 或 wide，從 wide 升回 rail 也保留緩衝', async () => {
        storage.set(modeKey, 'expanded');
        width = 700;
        await mount(RAIL_TIERS);
        expect(result.tier).toBe('rail');
        resize(640);
        expect(result.tier).toBe('wide');
        resize(650);
        expect(result.tier).toBe('wide');
        resize(730);
        expect(result.tier).toBe('rail');
    });

    it('字型 ready 與 loadingdone 排程重新量測，卸載移除同一個 handler', async () => {
        await mount();
        expect(reads).toBeGreaterThan(1); // 初次 fit 與 fonts.ready。
        const handler = fontHandlers.get('loadingdone')!;
        width = 590;
        handler(); flushFrames();
        expect(result.tier).toBe('mid');
        act(() => root!.unmount()); root = undefined;
        expect(fontRemove).toHaveBeenCalledWith('loadingdone', handler);
    });

    it('卸載後才完成的 fonts.ready 不得重建動畫影格或 data-tier', async () => {
        let ready!: () => void;
        Object.assign(document.fonts, { ready: new Promise<void>(resolve => { ready = resolve; }) });
        await mount();
        act(() => root!.unmount()); root = undefined;
        await act(async () => ready());
        expect(frames.size).toBe(0);
        flushFrames();
        expect(board.dataset.tier).toBeUndefined();
    });

    it('同一統計群內可見與隱藏欄位的長度對調仍重測，讀屏補充不影響簽章', async () => {
        const visible = { ...statistics, textContent: '999', get childNodes(): FakeLeaf['childNodes'] { return [{ nodeType: 3, textContent: this.textContent }]; } };
        const hidden = { ...statistics, textContent: '1,000', get childNodes(): FakeLeaf['childNodes'] { return [{ nodeType: 3, textContent: this.textContent }]; } };
        const details = { ...statistics, textContent: '補充', get childNodes(): FakeLeaf['childNodes'] { return [{ nodeType: 3, textContent: this.textContent }]; }, closest: () => ({}) };
        leaves = [price, visible, hidden, details];
        await mount();
        const before = reads;
        details.textContent = '更長的讀屏補充';
        act(() => root!.update(createElement(Probe, { signature: 'details' })));
        expect(reads).toBe(before);
        needs.wide = 700;
        visible.textContent = '1,000'; hidden.textContent = '999';
        act(() => root!.update(createElement(Probe, { signature: 'swapped' })));
        expect(result.tier).toBe('mid');
    });

    it('數字文字與單位元素混排時，預估量跨位數仍重新量測', async () => {
        const amount = { nodeType: 3, textContent: '9999.9' };
        const unit = { ...statistics, textContent: '億' };
        const value = { ...statistics, children: [unit], childNodes: [amount, { nodeType: 1, textContent: '億' }] };
        leaves = [price, value as unknown as FakeLeaf, unit];
        await mount();
        needs.wide = 700;
        amount.textContent = '10000.1';
        act(() => root!.update(createElement(Probe, { signature: 'amount digits' })));
        expect([result.tier, board.dataset.tier]).toEqual(['mid', 'mid']);
    });

    it('storage 只同步本看板的 key，清空儲存時重新讀取', async () => {
        await mount();
        storage.set(modeKey, 'collapsed');
        act(() => storageHandler({ key: 'sj-index-board-mode' }));
        expect(result.tier).toBe('wide');
        act(() => storageHandler({ key: modeKey }));
        expect(result.tier).toBe('strip');
        storage.clear();
        act(() => storageHandler({ key: null }));
        expect(result.tier).toBe('wide');
    });

    it('內容長度改變時重測；兩欄長度一增一減也不會互相抵銷', async () => {
        await mount();
        const before = reads;
        price.textContent = '3,000'; // 同樣 5 字，不需要 refit。
        act(() => root!.update(createElement(Probe, { signature: 'same length' })));
        expect(reads).toBe(before);
        needs.wide = 700;
        price.textContent = '3,00';
        statistics.textContent = '上漲100';
        act(() => root!.update(createElement(Probe, { signature: 'longer' })));
        expect([result.tier, board.dataset.tier]).toEqual(['mid', 'mid']);
    });
});
