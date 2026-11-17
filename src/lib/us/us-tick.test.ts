import { describe, expect, it } from 'vitest';
import { usRoundToTick, usStepPrice, usTickSize } from './us-tick';

describe('usTickSize（假設：Reg NMS sub-penny rule）', () => {
    it('boundaries', () => {
        expect(usTickSize('1')).toBe('0.01');
        expect(usTickSize('1.00')).toBe('0.01');
        expect(usTickSize('187.5')).toBe('0.01');
        expect(usTickSize('0.9999')).toBe('0.0001');
        expect(usTickSize('0.5')).toBe('0.0001');
    });
});

describe('usRoundToTick', () => {
    it('rounds to the tick of its band without float drift', () => {
        expect(usRoundToTick('187.505')).toBe('187.51');
        expect(usRoundToTick('187.504')).toBe('187.5');
        expect(usRoundToTick('0.12345')).toBe('0.1235');
        expect(usRoundToTick('0.1')).toBe('0.1');
    });
    it('0.9999x → 1.00 transition', () => {
        expect(usRoundToTick('0.99995')).toBe('1');
        expect(usRoundToTick('0.99994')).toBe('0.9999');
    });
    it('rejects non-positive and invalid input', () => {
        expect(usRoundToTick('0')).toBeNull();
        expect(usRoundToTick('-1')).toBeNull();
        expect(usRoundToTick('abc')).toBeNull();
    });
});

describe('usStepPrice', () => {
    it('steps by 0.01 above $1 with exact decimals', () => {
        expect(usStepPrice('0.1', 0)).toBe('0.1');
        expect(usStepPrice('187.5', 1)).toBe('187.51');
        expect(usStepPrice('187.5', -3)).toBe('187.47');
        expect(usStepPrice('10.29', 1)).toBe('10.3');
    });
    it('steps across $1 in both directions', () => {
        expect(usStepPrice('0.9999', 1)).toBe('1');
        expect(usStepPrice('0.9998', 3)).toBe('1.01');
        expect(usStepPrice('1', -1)).toBe('0.9999');
        expect(usStepPrice('1.01', -2)).toBe('0.9999');
    });
    it('stops at zero', () => {
        expect(usStepPrice('0.0001', -1)).toBeNull();
        expect(usStepPrice('0.0002', -1)).toBe('0.0001');
    });
});
