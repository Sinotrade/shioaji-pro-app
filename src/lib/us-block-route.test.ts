// 美股面板分流：主視窗與彈出視窗必須走同一套（Codex review：popout 曾繞過防護）
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { US_UNSUPPORTED, usBlockRoute } from './us-block-route';

const US = { region: 'US' as const };
const TW = { region: 'TW' as const };

describe('usBlockRoute', () => {
    it('blocks every unsupported panel for US contracts', () => {
        for (const t of US_UNSUPPORTED) expect(usBlockRoute(t, US)).toEqual({ kind: 'unsupported' });
    });
    it('routes chart, intraday, tape and depth to the US components', () => {
        expect(usBlockRoute('chart', US)).toEqual({ kind: 'chart' });
        expect(usBlockRoute('intraday', US)).toEqual({ kind: 'intraday' });
        expect(usBlockRoute('tape', US)).toEqual({ kind: 'tape' });
        expect(usBlockRoute('depth', US)).toEqual({ kind: 'depth' });
        for (const t of ['chart', 'intraday', 'tape', 'depth'] as const) expect(US_UNSUPPORTED.has(t)).toBe(false);
    });
    it('keeps panels without US data unsupported', () => {
        for (const t of ['depthmap', 'volprofile', 'replay', 'chips', 'optchain', 'conditional', 'backtest'] as const) {
            expect(usBlockRoute(t, US)).toEqual({ kind: 'unsupported' });
        }
    });
    it('leaves ticket/flash to their own wrappers and never touches TW', () => {
        expect(usBlockRoute('ticket', US)).toBeNull();
        expect(usBlockRoute('flash', US)).toBeNull();
        expect(usBlockRoute('chips', TW)).toBeNull();
        expect(usBlockRoute('chart', null)).toBeNull();
    });
});

describe('App wiring', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8');
    const body = (fn: string) => {
        const start = src.indexOf(`function ${fn}(`);
        expect(start).toBeGreaterThan(-1);
        return src.slice(start, src.indexOf('\n}\n', start));
    };

    it('popout applies the US guard before any panel-specific branch', () => {
        const popout = body('PopoutView');
        const guard = popout.indexOf('usBlockRoute(type, contract)');
        expect(guard).toBeGreaterThan(-1);
        for (const branch of ["type === 'pnl'", "type === 'optchain'", "type === 'combo'", 'switch (type)']) {
            expect(guard).toBeLessThan(popout.indexOf(branch));
        }
        expect(popout).toContain("usRoute?.kind === 'unsupported'");
        for (const kind of ['chart', 'intraday', 'tape', 'depth']) expect(popout).toContain(`usRoute?.kind === '${kind}'`);
    });

    it('main window BlockBody uses the same route', () => {
        const main = body('BlockBody');
        expect(main.indexOf('usBlockRoute(block.type, contract)')).toBeLessThan(main.indexOf('switch (block.type)'));
        for (const kind of ['chart', 'intraday', 'tape', 'depth']) expect(main).toContain(`usRoute?.kind === '${kind}'`);
    });
});
