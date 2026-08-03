import { describe, expect, it } from 'vitest';
import { BLOCK_META, LAYOUT_PRESETS } from './workspace';

describe('market pulse workspace preset', () => {
    it('opens distribution and flow panels side by side', () => {
        const preset = LAYOUT_PRESETS.find(
            (candidate) => candidate.name === '市場脈動',
        );

        expect(preset?.workspace.blocks).toEqual([
            expect.objectContaining({
                type: 'pulse',
                pulseVisualization: 'distribution',
            }),
            expect.objectContaining({
                type: 'pulse',
                pulseVisualization: 'flow',
            }),
        ]);
        expect(preset?.workspace.layout).toEqual([
            expect.objectContaining({ x: 0, w: 10 }),
            expect.objectContaining({ x: 10, w: 14 }),
        ]);
        expect(BLOCK_META.pulse.singleton).toBe(false);
    });
});
