import { describe, expect, it } from 'vitest';
import { MIN_MEMBER_R, PACK_GAP, PACK_RIM, packGroup, packScale, placeLabels, rimOf, SINGLE_RIM_MIN } from './portfolio-pack';

const dist = (a: { dx: number; dy: number }, b: { dx: number; dy: number }) => Math.hypot(a.dx - b.dx, a.dy - b.dy);

describe('packGroup', () => {
    it('packs members inside the rim without overlap, sized by √value', () => {
        const items = [
            { code: '2330', value: 4_000_000 },
            { code: '2454', value: 1_000_000 },
            { code: '3017', value: 1_000_000 },
            { code: '2308', value: 250_000 },
        ];
        const g = packGroup(items, 0.01);
        expect(g.members.map((m) => m.code)).toEqual(['2330', '2454', '3017', '2308']);
        expect(g.members[0]!.r).toBeCloseTo(20);
        expect(g.members[1]!.r).toBeCloseTo(10);
        for (const m of g.members) expect(Math.hypot(m.dx, m.dy) + m.r).toBeLessThanOrEqual(g.R - PACK_RIM + 1e-6);
        for (let i = 0; i < g.members.length; i += 1)
            for (let j = i + 1; j < g.members.length; j += 1)
                expect(dist(g.members[i]!, g.members[j]!)).toBeGreaterThanOrEqual(g.members[i]!.r + g.members[j]!.r + 2 * PACK_GAP - 1e-6);
    });

    it('is deterministic: ties break by code whatever the input order', () => {
        const a = packGroup([{ code: 'B', value: 9 }, { code: 'A', value: 9 }, { code: 'C', value: 4 }], 1);
        const b = packGroup([{ code: 'C', value: 4 }, { code: 'A', value: 9 }, { code: 'B', value: 9 }], 1);
        expect(a).toEqual(b);
        expect(a.members[0]!.code).toBe('A');
    });

    it('gives a single holding a visibly larger outer ring', () => {
        const one = packGroup([{ code: '2330', value: 10_000 }], 0.4); // r = 40
        expect(one.members[0]).toMatchObject({ dx: 0, dy: 0, r: 40 });
        expect(one.R - 40 - PACK_GAP).toBeCloseTo(40 * 0.35);
        expect(one.R - 40).toBeGreaterThan(PACK_RIM + PACK_GAP);
        const tiny = packGroup([{ code: 'X', value: 1 }], 1);
        expect(tiny.R - tiny.members[0]!.r - PACK_GAP).toBeCloseTo(SINGLE_RIM_MIN);
        expect(rimOf(2, 40)).toBe(PACK_RIM);
    });

    it('keeps tiny and zero holdings clickable', () => {
        const g = packGroup([{ code: 'A', value: 0 }, { code: 'B', value: -5 }], 0.001);
        expect(g.members.every((m) => m.r === MIN_MEMBER_R)).toBe(true);
        expect(packGroup([], 1)).toEqual({ members: [], R: PACK_RIM });
    });
});

describe('packScale', () => {
    const groups = [
        [{ code: 'A', value: 9_000_000 }, { code: 'B', value: 1_000_000 }],
        [{ code: 'C', value: 2_000_000 }],
        [{ code: 'D', value: 500_000 }],
    ];

    it('caps the biggest group at about a quarter of the short side', () => {
        const scale = packScale(groups, 1200, 400);
        const biggest = Math.max(...groups.map((g) => packGroup(g, scale).R - rimOf(g.length, packGroup(g, scale).members[0]!.r)));
        expect(biggest).toBeCloseTo(400 * 0.27, 1);
    });

    it('keeps the circles to about a quarter of a narrow plot', () => {
        const scale = packScale(groups, 600, 600);
        const area = groups.reduce((s, g) => {
            const p = packGroup(g, scale);
            const r = p.R - rimOf(g.length, p.members[0]!.r);
            return s + Math.PI * r * r;
        }, 0);
        expect(area).toBeLessThanOrEqual(0.24 * 600 * 600 * 1.001);
    });

    it('returns 0 without room or groups', () => {
        expect(packScale(groups, 0, 300)).toBe(0);
        expect(packScale([], 300, 300)).toBe(0);
    });
});

describe('placeLabels', () => {
    const frame = { top: 0, bottom: 600 };

    it('puts a label above its rim when nothing is in the way', () => {
        const p = placeLabels([{ id: 'a', x: 300, y: 300, R: 50, w: 120 }], frame);
        expect(p.get('a')).toEqual({ dx: 0, dy: -56 });
    });

    it('drops below the rim at the top of the frame', () => {
        const p = placeLabels([{ id: 'a', x: 300, y: 30, R: 30, w: 120 }], frame);
        expect(p.get('a')).toEqual({ dx: 0, dy: 45 });
    });

    it('never stacks two labels on each other', () => {
        // two circles side by side whose below-labels would overlap; the frame forbids above for both
        const circles = [
            { id: 'big', x: 300, y: 30, R: 28, w: 160 },
            { id: 'small', x: 330, y: 40, R: 14, w: 120 },
        ];
        const p = placeLabels(circles, frame);
        const box = (id: string) => {
            const c = circles.find((x) => x.id === id)!;
            const l = p.get(id)!;
            return { x0: c.x + l.dx - c.w / 2, x1: c.x + l.dx + c.w / 2, y0: c.y + l.dy - 12, y1: c.y + l.dy + 3 };
        };
        const a = box('big');
        const b = box('small');
        const overlap = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > 0 && Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > 0;
        expect(overlap).toBe(false);
    });
});
