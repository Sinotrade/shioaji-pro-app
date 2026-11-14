// @vitest-environment jsdom
// 回歸測試（Codex review 1f4c1b04）：一律用真的 KeyboardEvent —
// code／修飾鍵是 prototype getter，用純物件測不出 {...e} 展開後遺失的問題。

import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { drawingBulkKeyOf, orderLockKeyOf, toolShortcutOf, undoKeyOf } from '../../hooks/use-chart-drawings';
import { useHotkeys } from '../../hooks/use-hotkeys';
import { ShortcutHelpHost } from '../../components/shortcuts/shortcut-help';
import { matchesShortcut } from './match';
import { checkBinding, defById, effectiveKeys, firstConflict, sanitizeOverrides } from './registry';
import {
    __setOverridesForTests,
    __setShortcutPlatformForTests,
    getShortcutState,
    resetAllBindings,
    resetBinding,
    setBinding,
} from './store';

const checkBindingFor = (id: string, chord: string) => checkBinding(defById(id)!, chord, {}, 'mac');

vi.mock('../../lib/trade', () => ({ cancelAllOrders: vi.fn(async () => {}), notify: vi.fn() }));

const kd = (init: KeyboardEventInit) => new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });

beforeEach(() => {
    localStorage.clear();
    __setShortcutPlatformForTests('mac');
    resetAllBindings();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});
afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
});

describe('P1：K 線圖按鍵比對收到真的 KeyboardEvent', () => {
    it.each(['mac', 'win'] as const)('%s：復原／重做／委託線鎖定／畫圖工具／隱藏全部畫圖', (platform) => {
        __setShortcutPlatformForTests(platform);
        const mod = platform === 'mac' ? { metaKey: true } : { ctrlKey: true };
        expect(undoKeyOf(kd({ code: 'KeyZ', key: 'z', ...mod }))).toBe('undo');
        expect(undoKeyOf(kd({ code: 'KeyZ', key: 'z', shiftKey: true, ...mod }))).toBe('redo');
        expect(undoKeyOf(kd({ code: 'KeyY', key: 'y', ...mod }))).toBe('redo');
        expect(orderLockKeyOf(kd({ code: 'KeyL', key: 'l', ...mod }))).toBe(true);
        expect(toolShortcutOf(kd({ code: 'KeyT', key: '†', altKey: true }))).toBe('trend');
        expect(drawingBulkKeyOf(kd({ code: 'KeyH', key: 'Ó', altKey: true, shiftKey: true }))).toBe('toggleHidden');
        // 沒有修飾鍵時都不是
        expect(undoKeyOf(kd({ code: 'KeyZ', key: 'z' }))).toBeNull();
        expect(toolShortcutOf(kd({ code: 'KeyT', key: 't' }))).toBeNull();
    });
});

describe('P2：沒有 ⌘／Ctrl／Alt 的全域鍵在輸入框與組字中不觸發', () => {
    let root: ReactTestRenderer | undefined;
    const onOpenPalette = vi.fn();
    beforeEach(async () => {
        onOpenPalette.mockClear();
        function Probe() {
            useHotkeys({ onOpenPalette, onAfterCancelAll: () => {} });
            return null;
        }
        await act(async () => {
            root = create(createElement(Probe));
        });
    });
    afterEach(async () => {
        await act(async () => root?.unmount());
    });

    it('改鍵規則：全域項目不接受單鍵或 Shift＋字母', () => {
        expect(checkBindingFor('palette.open', 'KeyK').level).toBe('block');
        expect(checkBindingFor('help.open', 'Shift+KeyH').level).toBe('block');
        expect(checkBindingFor('palette.open', 'Mod+Alt+KeyK').level).not.toBe('block');
    });

    it('執行期防線：即使存了單鍵（舊資料），輸入框內與組字中不觸發', () => {
        __setOverridesForTests({ 'palette.open': ['KeyK'] });
        const input = document.createElement('input');
        document.body.append(input);
        input.focus();
        input.dispatchEvent(kd({ code: 'KeyK', key: 'k' }));
        expect(onOpenPalette).not.toHaveBeenCalled();
        input.blur();
        document.body.dispatchEvent(kd({ code: 'KeyK', key: 'k', isComposing: true }));
        expect(onOpenPalette).not.toHaveBeenCalled();
        document.body.dispatchEvent(kd({ code: 'KeyK', key: 'k' }));
        expect(onOpenPalette).toHaveBeenCalledTimes(1);
    });

    it('帶 ⌘ 的全域鍵在輸入框內照常可用，組字中不處理', () => {
        const input = document.createElement('input');
        document.body.append(input);
        input.focus();
        input.dispatchEvent(kd({ code: 'KeyK', key: 'k', metaKey: true }));
        expect(onOpenPalette).toHaveBeenCalledTimes(1);
        input.dispatchEvent(kd({ code: 'KeyK', key: 'k', metaKey: true, isComposing: true }));
        expect(onOpenPalette).toHaveBeenCalledTimes(1);
    });

    it('提示頁：單鍵綁定在輸入框內不開，⌘/ 照常可開', async () => {
        let help: ReactTestRenderer | undefined;
        await act(async () => {
            help = create(createElement(ShortcutHelpHost));
        });
        __setOverridesForTests({ 'help.open': ['KeyH'] });
        const input = document.createElement('input');
        document.body.append(input);
        input.focus();
        await act(async () => {
            input.dispatchEvent(kd({ code: 'KeyH', key: 'h' }));
        });
        expect(help!.toJSON()).toBeNull();
        __setOverridesForTests({});
        await act(async () => {
            input.dispatchEvent(kd({ code: 'Slash', key: '/', metaKey: true, isComposing: true }));
        });
        expect(help!.toJSON()).toBeNull();
        await act(async () => {
            input.dispatchEvent(kd({ code: 'Slash', key: '/', metaKey: true }));
        });
        expect(help!.toJSON()).not.toBeNull();
        await act(async () => help!.unmount());
    });
});

describe('P2：回復預設也要檢查衝突', () => {
    it('預設鍵已被別人用掉時拒絕，指定取代才回復，且不會兩項共用一鍵', () => {
        expect(setBinding('help.open', 'Mod+Alt+KeyU')).toBe(true);
        expect(setBinding('palette.open', 'Mod+Slash')).toBe(true);
        const r = resetBinding('help.open');
        expect(r.ok).toBe(false);
        expect(!r.ok && r.check.level === 'conflict' && r.check.other.id).toBe('palette.open');
        // 被拒絕時維持原狀：⌘/ 只屬於商品搜尋
        const slash = kd({ code: 'Slash', key: '/', metaKey: true });
        expect(matchesShortcut('palette.open', slash)).toBe(true);
        expect(matchesShortcut('help.open', slash)).toBe(false);
        expect(resetBinding('help.open', 'palette.open').ok).toBe(true);
        expect(matchesShortcut('help.open', slash)).toBe(true);
        expect(matchesShortcut('palette.open', slash)).toBe(false);
        expect(effectiveKeys(defById('palette.open')!, getShortcutState().overrides)).toEqual([]);
        expect(firstConflict(getShortcutState().overrides, 'mac')?.some((d) => d.id === 'help.open' || d.id === 'palette.open') ?? false).toBe(false);
    });
});

describe('P2：讀回清理產生沒有衝突的最終表', () => {
    it('help=⌘K 留下、palette=⌘Q 被丟回預設 ⌘K → 撞到時丟掉 help 的覆寫', () => {
        const clean = sanitizeOverrides({ 'help.open': ['Mod+KeyK'], 'palette.open': ['Mod+KeyQ'] }, 'mac');
        expect(clean).toEqual({});
        expect(firstConflict(clean, 'mac')?.some((d) => d.id in clean) ?? false).toBe(false);
    });

    it('連鎖：丟掉的覆寫回到預設後再撞到別人，也一路清到沒有衝突', () => {
        const clean = sanitizeOverrides(
            {
                'draw.trend': ['Alt+KeyH'], // 撞水平線預設 → 但水平線改成 Alt+KeyV
                'draw.horizontal': ['Alt+KeyV'], // 撞垂直線預設
                'draw.vertical': ['Mod+KeyC'], // 保留鍵 → 回預設 Alt+KeyV
            },
            'mac',
        );
        expect(firstConflict(clean, 'mac')?.some((d) => d.id in clean) ?? false).toBe(false);
        expect(clean['draw.vertical']).toBeUndefined();
        // 用真的按鍵確認：每個鍵最多一個畫圖工具
        for (const code of ['KeyH', 'KeyV', 'KeyT']) {
            const e = kd({ code, altKey: true });
            const hits = ['draw.trend', 'draw.horizontal', 'draw.vertical'].filter((id) => {
                __setOverridesForTests(clean);
                return matchesShortcut(id, e);
            });
            expect(hits.length, code).toBeLessThanOrEqual(1);
        }
    });

    it('讀回後的狀態套用到 store：localStorage 有衝突資料也不會兩項同鍵', () => {
        localStorage.setItem('sj-pro-shortcuts', JSON.stringify({ v: 1, overrides: { 'help.open': ['Mod+KeyK'], 'palette.open': ['Mod+KeyQ'] } }));
        __setShortcutPlatformForTests('mac');
        const k = kd({ code: 'KeyK', key: 'k', metaKey: true });
        expect([matchesShortcut('help.open', k), matchesShortcut('palette.open', k)]).toEqual([false, true]);
    });
});
