import { describe, expect, it } from 'vitest';
import { BLOCK_META, LAYOUT_PRESETS } from './workspace';

describe('market pulse workspace preset', () => {
    it('opens one resizable panel with all contribution modules', () => {
        const preset = LAYOUT_PRESETS.find(
            (candidate) => candidate.name === '市場脈動',
        );

        expect(preset?.workspace.blocks).toEqual([
            expect.objectContaining({
                type: 'pulse',
                pulseSections: ['stocks', 'industries', 'flow'],
                pulseWeights: {
                    stocks: 28,
                    industries: 32,
                    flow: 40,
                },
            }),
        ]);
        expect(preset?.workspace.layout).toEqual([
            expect.objectContaining({ x: 0, w: 24 }),
        ]);
        expect(BLOCK_META.pulse.singleton).toBe(false);
    });
});
