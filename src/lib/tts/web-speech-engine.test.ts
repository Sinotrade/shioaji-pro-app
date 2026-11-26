import { expect, it } from 'vitest';
import { rateToSpeed } from './web-speech-engine';

it('maps the abstract rate scale (-10~20) onto the Web Speech speed', () => {
    expect(rateToSpeed(0)).toBeCloseTo(1);
    expect(rateToSpeed(4)).toBeCloseTo(1.4);
    expect(rateToSpeed(10)).toBeCloseTo(2); // 舊上限：2.0 倍（既有設定值不受影響）
    expect(rateToSpeed(20)).toBeCloseTo(3); // 新上限：3.0 倍
    expect(rateToSpeed(-10)).toBeCloseTo(0.1);
});

it('clamps out-of-range rates instead of passing them through', () => {
    expect(rateToSpeed(99)).toBeCloseTo(3);
    expect(rateToSpeed(-99)).toBeCloseTo(0.1);
});

it('keeps the speed inside the range the Web Speech API accepts', () => {
    for (let rate = -20; rate <= 20; rate++) {
        const speed = rateToSpeed(rate);
        expect(speed).toBeGreaterThanOrEqual(0.1);
        expect(speed).toBeLessThanOrEqual(3);
    }
});
