import { describe, expect, it } from 'vitest';
import {
    approach,
    bandThickness,
    capParticles,
    easeStep,
    headRadius,
    magnitude,
    MAX_PARTICLES,
    particleAlpha,
    particleSpeed,
    spawnCount,
    spawnRate,
} from './chain-river';

describe('easeStep', () => {
    it('snaps under reduced motion', () => {
        expect(easeStep(0.016, 10, true)).toBe(1);
    });
    it('is frame-rate independent', () => {
        // two 8 ms steps cover the same distance as one 16 ms step
        const one = easeStep(0.016, 10);
        const half = easeStep(0.008, 10);
        expect(1 - (1 - half) * (1 - half)).toBeCloseTo(one, 10);
    });
    it('clamps long stalls and rejects bad input', () => {
        expect(easeStep(5, 10)).toBe(easeStep(0.1, 10));
        expect(easeStep(0, 10)).toBe(0);
        expect(easeStep(-1, 10)).toBe(0);
        expect(easeStep(Number.NaN, 10)).toBe(0);
    });
});

describe('approach', () => {
    it('moves part of the way and lands exactly', () => {
        expect(approach(0, 100, 0.5)).toBe(50);
        expect(approach(99.995, 100, 0.5)).toBe(100);
        expect(approach(0, 100, 1)).toBe(100);
    });
});

describe('magnitude', () => {
    it('is square-root scaled and clamped', () => {
        expect(magnitude(25, 100)).toBeCloseTo(0.5);
        expect(magnitude(-25, 100)).toBeCloseTo(0.5);
        expect(magnitude(200, 100)).toBe(1);
        expect(magnitude(1, 0)).toBe(0);
        expect(magnitude(Number.NaN, 1)).toBe(0);
    });
});

describe('spawning', () => {
    it('scales with magnitude', () => {
        expect(spawnRate(0)).toBe(6);
        expect(spawnRate(1)).toBe(52);
        expect(spawnRate(5)).toBe(52);
    });
    it('emits the whole part and the fraction by chance', () => {
        expect(spawnCount(50, 0.05, () => 0.99)).toBe(2);
        expect(spawnCount(50, 0.05, () => 0.1)).toBe(3);
        expect(spawnCount(10, 0, () => 0)).toBe(0);
        // a stalled frame does not burst
        expect(spawnCount(50, 10, () => 0.99)).toBe(5);
    });
    it('averages to rate × dt', () => {
        let seed = 7;
        const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
        let n = 0;
        for (let i = 0; i < 6000; i++) n += spawnCount(30, 1 / 60, rand);
        expect(n / 100).toBeGreaterThan(27);
        expect(n / 100).toBeLessThan(33);
    });
});

describe('particles', () => {
    it('run faster on bigger flows', () => {
        expect(particleSpeed(1, 0)).toBeGreaterThan(particleSpeed(0, 0));
    });
    it('fade in off the axis and out at the head', () => {
        expect(particleAlpha(0)).toBe(0);
        expect(particleAlpha(1)).toBe(0);
        expect(particleAlpha(0.05)).toBeLessThan(particleAlpha(0.2));
        expect(particleAlpha(0.9)).toBeLessThan(particleAlpha(0.3));
        for (let p = 0; p <= 1; p += 0.01) expect(particleAlpha(p)).toBeLessThanOrEqual(1);
    });
    it('cap drops the oldest first', () => {
        const list = Array.from({ length: MAX_PARTICLES + 5 }, (_, i) => i);
        const capped = capParticles(list);
        expect(capped).toHaveLength(MAX_PARTICLES);
        expect(capped[0]).toBe(5);
        const small = [1, 2];
        expect(capParticles(small)).toBe(small);
    });
});

describe('band geometry', () => {
    it('thickness follows turnover between 3 and 16 px', () => {
        expect(bandThickness(0, 100)).toBe(3);
        expect(bandThickness(100, 100)).toBe(16);
        expect(bandThickness(1000, 100)).toBe(16);
        expect(bandThickness(25, 100)).toBeCloseTo(9.5);
    });
    it('head grows with the band', () => {
        expect(headRadius(3)).toBe(2);
        expect(headRadius(16)).toBeGreaterThan(headRadius(8));
    });
});
