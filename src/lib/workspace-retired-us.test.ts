// 舊版面的美股下單面板（usorder）讀入時移除，並提示一次
import { describe, expect, it } from 'vitest';
import { DEFAULT_WORKSPACE, sanitizeWorkspace, takeRetiredPanelCount, unsupportedPanelCount, type Workspace } from './workspace';

describe('retired usorder panel', () => {
    it('drops usorder blocks (not kept as unsupported) and reports the count once', () => {
        const ws = structuredClone(DEFAULT_WORKSPACE) as Workspace;
        const legacy = {
            ...ws,
            blocks: [...ws.blocks, { id: 'us1', type: 'usorder' } as unknown as Workspace['blocks'][number]],
            layout: [...ws.layout, { i: 'us1', x: 0, y: 0, w: 5, h: 13 }],
        } as Workspace;
        takeRetiredPanelCount();
        const out = sanitizeWorkspace(legacy);
        expect(out.blocks.some((b) => b.id === 'us1')).toBe(false);
        expect(out.layout.some((l) => l.i === 'us1')).toBe(false);
        expect(unsupportedPanelCount(out)).toBe(0);
        expect(takeRetiredPanelCount()).toBe(1);
        expect(takeRetiredPanelCount()).toBe(0);
    });
});
