import { describe, expect, it, vi } from 'vitest';

// The panel module pulls in app modules that touch window/localStorage at load.
vi.hoisted(() => {
    const storage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
    Object.assign(globalThis, {
        window: Object.assign(globalThis, { addEventListener: () => undefined, removeEventListener: () => undefined }),
        localStorage: storage,
    });
});
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { Financials } from '../lib/company-data/types';
import type { ContractInfo } from '../lib/types/contract';
import { companyTarget, fmtTwd, REVENUE_CHART_H, RevenueChartSvg } from './company-panel';

const c = (fields: Partial<ContractInfo>) => fields as ContractInfo;

describe('company panel helpers (#337)', () => {
    it('follows stocks and stock-future underlyings, not indices', () => {
        expect(companyTarget(c({ security_type: 'STK', code: '2330' }))).toEqual({ code: '2330', viaUnderlying: false });
        expect(companyTarget(c({ security_type: 'FUT', code: 'CDFR1', underlying_code: '2330' }))).toEqual({ code: '2330', viaUnderlying: true });
        expect(companyTarget(c({ security_type: 'FUT', code: 'TXFR1', underlying_kind: 'I', underlying_code: '#001' }))).toBeNull();
        expect(companyTarget(c({ security_type: 'IND', code: '001' }))).toBeNull();
    });

    it('formats TWD amounts in 兆 / 億 / 萬', () => {
        expect(fmtTwd(62.37e12)).toBe('62.37 兆');
        expect(fmtTwd(5.119e11)).toBe('5,119 億');
        expect(fmtTwd(3.5e8)).toBe('3.5 億');
        expect(fmtTwd(null)).toBe('—');
    });
});

describe('monthly revenue chart (#351)', () => {
    const fin = JSON.parse(
        readFileSync(new URL('../lib/company-data/__fixtures__/financials-2330.json', import.meta.url), 'utf8'),
    ) as Financials;

    // Regression: a fixed 360-wide viewBox stretched to the panel width scaled
    // the 9px axis labels (25px+ in a wide panel). The SVG must be drawn at its
    // real pixel size so its text is never scaled.
    it.each([240, 360, 868, 1400])('draws at its pixel size, unscaled, at width %i', async (width) => {
        vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
        let view: ReactTestRenderer | undefined;
        await act(async () => {
            view = create(createElement(RevenueChartSvg, { fin, width }));
        });
        const svg = view!.root.findByType('svg');
        expect(svg.props.width).toBe(width);
        expect(svg.props.height).toBe(REVENUE_CHART_H);
        expect(svg.props.viewBox).toBe(`0 0 ${width} ${REVENUE_CHART_H}`);
        const dates = svg.findAllByType('text').filter((t) => /^\d{4}-\d{2}$/.test(String(t.props.children)));
        expect(dates).toHaveLength(3);
        for (const t of dates) {
            expect(t.props.x).toBeGreaterThanOrEqual(0);
            expect(t.props.x).toBeLessThanOrEqual(width);
        }
        await act(async () => view!.unmount());
        vi.unstubAllGlobals();
    });
});
