import { describe, expect, it } from 'vitest';
import { BLOCK_META, LAYOUT_PRESETS } from './workspace';

describe('market pulse workspace preset', () => {
    it('opens TSE and OTC contribution panels side by side', () => {
        const preset = LAYOUT_PRESETS.find(
            (candidate) => candidate.name === '市場脈動',
        );

        expect(preset?.workspace.blocks).toEqual([
            expect.objectContaining({
                type: 'pulse',
                pulseIndex: 'IX0001',
                pulseSections: ['flow'],
                pulseWeights: {
                    stocks: 28,
                    industries: 32,
                    flow: 40,
                },
            }),
            expect.objectContaining({
                type: 'pulse',
                pulseIndex: 'IX0043',
                pulseSections: ['flow'],
            }),
        ]);
        expect(preset?.workspace.layout).toEqual([
            expect.objectContaining({ x: 0, w: 12 }),
            expect.objectContaining({ x: 12, w: 12 }),
        ]);
        expect(BLOCK_META.pulse.singleton).toBe(false);
        expect(BLOCK_META.signals.singleton).toBe(true);
    });
});

describe('signal radar workspace preset', () => {
    it('links signals to chart, depth, and time and sales panels', () => {
        const preset = LAYOUT_PRESETS.find(
            (candidate) => candidate.name === '訊號雷達',
        );

        expect(preset?.workspace.blocks).toEqual([
            expect.objectContaining({ type: 'signals', pin: null }),
            expect.objectContaining({ type: 'chart', pin: null }),
            expect.objectContaining({ type: 'depth', pin: null }),
            expect.objectContaining({ type: 'tape', pin: null }),
        ]);
        expect(preset?.workspace.layout).toEqual([
            expect.objectContaining({ x: 0, w: 6, h: 24 }),
            expect.objectContaining({ x: 6, w: 13, h: 24 }),
            expect.objectContaining({ x: 19, y: 0, w: 5 }),
            expect.objectContaining({ x: 19, y: 10, w: 5 }),
        ]);
    });
});
