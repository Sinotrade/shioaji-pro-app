import { describe, expect, it } from 'vitest';
import { DAYTRADE_DEFAULTS, evaluateDaytrade, type DaytradeInput } from './daytrade-picker';
import type { Candle, Snapshot } from './types/market';
import type { ContractInfo } from './types/contract';

const date = '2026-10-07';
const today = Date.parse(`${date}T00:00:00Z`) / 1_000;
const now = (time = '09:40:30') => Date.parse(`${date}T${time}+08:00`);
const day = 86_400;

function previousSessionDays(count: number): number[] {
    const days: number[] = [];
    for (let label = today - day; days.length < count; label -= day) {
        const weekday = new Date(label * 1_000).getUTCDay();
        if (weekday !== 0 && weekday !== 6) days.unshift(label);
    }
    return days;
}

function contract(code = '2330'): ContractInfo {
    return {
        region: 'TW', security_type: 'STK', exchange: 'TSE', code, target_code: null,
        name: `測試${code}`, currency: 'TWD', day_trade: 'Yes', update_date: date,
        limit_up: 119, limit_down: 97, reference: 108.2, category: '24',
        margin_trading_balance: 0, short_selling_balance: 0,
        unit: 1_000, trading_suspended: false, disposition_level: 0,
    } as ContractInfo;
}

function daily(direction: 1 | -1 = 1): Candle[] {
    const days = previousSessionDays(40);
    return Array.from({ length: 40 }, (_, i) => {
        const close = 100 + direction * (i * 0.2 + (i % 2 ? 0.4 : -0.4));
        return { time: days[i]!, open: close - direction * 0.3,
            high: close + 1.5, low: close - 1.5, close, volume: i === 39 ? 3_000 : 2_000 };
    });
}

function session(sessionDay: number, base: number, direction: 1 | -1, volume = 100, count = 40): Candle[] {
    return Array.from({ length: count }, (_, i) => {
        const close = base + direction * (0.12 + i * 0.018);
        const open = close - direction * 0.018;
        return { time: sessionDay + 9 * 3_600 + (i + 1) * 60,
            open, high: Math.max(open, close) + 0.04, low: Math.min(open, close) - 0.04,
            close, volume };
    });
}

function input(direction: 1 | -1 = 1, code = '2330'): DaytradeInput {
    const history = daily(direction);
    const previous = history.at(-1)!.close;
    const price = previous + direction * 0.85;
    const snap: Snapshot = {
        code, exchange: 'TSE', datetime: `${date}T09:40:25+08:00`,
        open: previous + direction * 0.1, high: Math.max(previous, price) + 0.2,
        low: Math.min(previous, price) - 0.2, close: price, average_price: previous + direction * 0.5,
        buy_price: price - 0.1, buy_volume: 10, sell_price: price + 0.1, sell_volume: 12,
        volume: 100, total_volume: 8_000, amount: 100_000,
        total_amount: 850_000_000, change_price: direction * 0.85,
        change_rate: direction * 0.8, change_type: '1', tick_type: '1',
        volume_ratio: 99, yesterday_volume: 3_000,
    };
    return {
        contract: { ...contract(code), reference: previous, limit_up: previous * 1.1, limit_down: previous * 0.9 },
        daily: history,
        minutes: [...Array.from({ length: 14 }, (_, i) => session(history[history.length - 14 + i]!.time, previous, direction))
            .flat(), ...session(today, previous, direction, 200)],
        snapshot: snap, shortSource: { quantity: 100, datetime: `${date}T09:40:25+08:00` },
    };
}

const failure = (value: DaytradeInput, timestamp = now()) => evaluateDaytrade([value], timestamp).excluded[0]?.reasons.join('；') ?? '';

describe('independent daytrade research ranking', () => {
    it('separates prior-session observation from causal intraday confirmation', () => {
        const result = evaluateDaytrade([input()], now(), 0);
        expect(result.tradeDate).toBe(date);
        expect(result.phase).toBe('live');
        expect(result.long).toHaveLength(1);
        expect(result.short).toHaveLength(0);
        expect(result.observationsLong).toHaveLength(1);
        expect(result.long[0]!).toMatchObject({ rvol: 2, volumeRatio: 1.5, qualificationDate: date });
        expect(result.long[0]!.score).toBeLessThanOrEqual(100);
        expect(result.long[0]!.signal).toContain('研究候選');
        expect(result.long[0]!.reasons.join(' ')).toContain('不是勝率');
        expect(result.observationsLong[0]!.asOf).toBe('2026-10-06T13:30:00+08:00');
        expect(result.observationsLong[0]!.rvol).toBeNull();
    });

    it('confirms the symmetrical short setup only with fresh positive source quantity', () => {
        const value = input(-1);
        expect(evaluateDaytrade([value], now(), 0).short).toHaveLength(1);
        value.shortSource = undefined;
        const result = evaluateDaytrade([value], now());
        expect(result.short).toHaveLength(0);
        expect(result.observationsShort).toHaveLength(1);
        expect(failure(value)).toContain('可供券');
        value.shortSource = { quantity: 0, datetime: `${date}T09:40:25+08:00` };
        expect(evaluateDaytrade([value], now()).short).toHaveLength(0);
        value.shortSource = { quantity: 100, datetime: `${date}T09:35:00+08:00` };
        expect(evaluateDaytrade([value], now()).short).toHaveLength(0);
    });

    it('allows long OnlyBuy but never short OnlyBuy or unknown eligibility', () => {
        const long = input();
        long.contract.day_trade = 'OnlyBuy';
        expect(evaluateDaytrade([long], now()).long).toHaveLength(1);
        const short = input(-1);
        short.contract.day_trade = 'OnlyBuy';
        const result = evaluateDaytrade([short], now());
        expect(result.short).toHaveLength(0);
        expect(result.observationsShort).toHaveLength(0);
        expect(failure(short)).toContain('僅可先買');
        long.contract.day_trade = '';
        expect(failure(long)).toContain('資格為否或不明');
    });

    it.each(['unit', 'trading_suspended', 'disposition_level'] as const)('fails closed for missing %s metadata', field => {
        const value = input();
        delete (value.contract as unknown as Record<string, unknown>)[field];
        expect(evaluateDaytrade([value], now()).long).toHaveLength(0);
        expect(evaluateDaytrade([value], now()).observationsLong).toHaveLength(0);
    });

    it('excludes stale qualification, suspended stocks, disposition, nonordinary instruments and wrong regions', () => {
        const mutations: Partial<ContractInfo>[] = [
            { update_date: '2026-10-06' }, { code: '0050' }, { security_type: 'FUT' },
            { region: 'US' }, { exchange: 'OES' }, { currency: 'USD' },
            { trading_suspended: true } as Partial<ContractInfo>,
            { disposition_level: 1 } as Partial<ContractInfo>,
        ];
        for (const change of mutations) {
            const value = input();
            Object.assign(value.contract, change);
            const result = evaluateDaytrade([value], now());
            expect(result.long).toHaveLength(0);
            expect(result.observationsLong).toHaveLength(0);
            expect(result.excluded).toHaveLength(1);
        }
    });

    it('does not use snapshot volume_ratio as same-clock RVOL or as completed daily ratio', () => {
        const value = input();
        value.minutes = value.minutes.filter(bar => bar.time >= today);
        value.snapshot!.volume_ratio = 9_999;
        const result = evaluateDaytrade([value], now());
        expect(result.long).toHaveLength(0);
        expect(result.observationsLong[0]!.volumeRatio).toBe(1.5);
        expect(result.observationsLong[0]!.rvol).toBeNull();
        expect(failure(value)).toContain('不足 14');
    });

    it('requires at least 14 complete historical prefixes and ignores incomplete days', () => {
        const value = input();
        const oldest = value.daily.at(-14)!.time;
        value.minutes = value.minutes.filter(bar => bar.time !== oldest + 9 * 3_600 + 10 * 60);
        expect(failure(value)).toContain('不足 14');
        value.minutes.unshift(...session(value.daily.at(-15)!.time, value.daily.at(-1)!.close, 1));
        expect(evaluateDaytrade([value], now()).long).toHaveLength(1);
    });

    it('requires actual same-clock volume expansion and never compares against full past-day volume', () => {
        const value = input();
        value.minutes = value.minutes.map(bar => bar.time >= today ? { ...bar, volume: 140 } : bar);
        expect(failure(value)).toContain('未達 1.5');
        value.minutes = value.minutes.map(bar => bar.time >= today ? { ...bar, volume: 150 } : bar);
        expect(evaluateDaytrade([value], now()).long[0]!.rvol).toBe(1.5);
    });

    it('ignores future daily rows, future minutes and the current partial five-minute tail', () => {
        const value = input();
        const baseline = evaluateDaytrade([value], now());
        value.daily.push({ ...value.daily.at(-1)!, time: today, close: 10_000, high: 10_000, volume: 1e9 });
        value.daily.push({ ...value.daily.at(-1)!, time: today + day });
        value.minutes.push(...session(today, 10_000, 1, 1e9, 42).slice(40));
        value.minutes.push(...session(today + day, 10_000, 1, 1e9));
        expect(evaluateDaytrade([value], now())).toEqual(baseline);
    });

    it('uses only the latest sealed five-minute boundary and does not stitch a current gap', () => {
        const value = input();
        value.minutes = value.minutes.filter(bar => bar.time !== today + 9 * 3_600 + 12 * 60);
        expect(failure(value)).toContain('不拼接');
        expect(evaluateDaytrade([value], now()).observationsLong).toHaveLength(1);
    });

    it('rejects duplicated, out-of-order or invalid current prefix bars', () => {
        for (const kind of ['duplicate', 'out-of-order', 'invalid']) {
            const value = input();
            const index = value.minutes.findIndex(bar => bar.time > today);
            if (kind === 'duplicate') value.minutes.splice(index, 0, value.minutes[index]!);
            if (kind === 'out-of-order') [value.minutes[index], value.minutes[index + 1]] = [value.minutes[index + 1]!, value.minutes[index]!];
            if (kind === 'invalid') value.minutes[index]!.high = 0;
            expect(failure(value)).toContain('不拼接');
        }
    });

    it('waits for 8 closed five-minute bars and does not synthesize EMA8 from fewer bars', () => {
        const value = input();
        value.snapshot!.datetime = `${date}T09:35:25+08:00`;
        expect(failure(value, now('09:35:30'))).toContain('最早 09:40');
        expect(evaluateDaytrade([value], now('09:35:30')).long).toHaveLength(0);
    });

    it.each(['stale', 'future', 'wrong-date', 'wrong-code', 'wrong-exchange', 'invalid'])('rejects %s quote', kind => {
        const value = input();
        if (kind === 'stale') value.snapshot!.datetime = `${date}T09:35:00+08:00`;
        if (kind === 'future') value.snapshot!.datetime = `${date}T09:40:31+08:00`;
        if (kind === 'wrong-date') value.snapshot!.datetime = '2026-10-06T09:40:25+08:00';
        if (kind === 'wrong-code') value.snapshot!.code = '2303';
        if (kind === 'wrong-exchange') value.snapshot!.exchange = 'OTC';
        if (kind === 'invalid') value.snapshot!.datetime = 'not-a-timestamp';
        expect(failure(value)).toContain('報價不匹配');
    });

    it('accepts Taipei timezone-free server timestamps without treating them as UTC', () => {
        const value = input();
        value.snapshot!.datetime = `${date} 09:40:25`;
        expect(evaluateDaytrade([value], now()).long).toHaveLength(1);
    });

    it('rejects spread, crossed/locked book, empty book and malformed price ranges', () => {
        for (const mutation of [
            { sell_price: 110 }, { sell_price: 108 }, { sell_price: 108.95, buy_price: 108.95 },
            { buy_volume: 0 }, { total_amount: 0 }, { high: 1 },
        ]) {
            const value = input();
            Object.assign(value.snapshot!, mutation);
            expect(evaluateDaytrade([value], now()).long).toHaveLength(0);
        }
    });

    it('requires closed-bar ORB, VWAP and EMA agreement instead of a tick-only breakout', () => {
        const value = input();
        value.minutes = value.minutes.map(bar => bar.time >= today
            ? { ...bar, open: 108.2, high: 108.6, low: 108, close: 108.2 } : bar);
        expect(failure(value)).toContain('尚未同向');
    });

    it('excludes chasing too far from VWAP or opening range, and too near the limit', () => {
        const value = input();
        value.snapshot!.close = 112;
        value.snapshot!.high = 112.1;
        value.snapshot!.buy_price = 111.9;
        value.snapshot!.sell_price = 112.1;
        expect(failure(value)).toMatch(/距 VWAP|距開盤突破點/);
        const limited = input();
        limited.contract.limit_up = limited.snapshot!.close * 1.004;
        expect(failure(limited)).toContain('距漲跌停');
    });

    it('applies user overheat limits on current causal data and mirrored oversold limits for shorts', () => {
        for (const direction of [1, -1] as const) {
            const value = input(direction);
            const previous = value.daily.at(-1)!.close;
            const price = previous * (direction === 1 ? 1.09 : 0.91);
            Object.assign(value.snapshot!, { close: price, high: Math.max(previous, price) + 1,
                low: Math.min(previous, price) - 1, buy_price: price - 0.05, sell_price: price + 0.05 });
            expect(failure(value)).toMatch(/單日漲幅|單日跌幅/);
        }
    });

    it('checks the exact 8% opening-gap boundary for each side even when price later retraces', () => {
        for (const direction of [1, -1] as const) {
            const value = input(direction);
            const previous = value.daily.at(-1)!.close;
            value.snapshot!.open = previous * (direction === 1 ? 1.08 : 0.92);
            value.snapshot!.high = Math.max(value.snapshot!.open, value.snapshot!.close) + 0.1;
            value.snapshot!.low = Math.min(value.snapshot!.open, value.snapshot!.close) - 0.1;
            expect(failure(value)).toContain(direction === 1 ? '向上跳空 ≥ 8%' : '向下跳空 ≥ 8%');
        }
    });

    it('checks RSI and MA20 bias guards independently from liquidity and source confirmation', () => {
        for (const direction of [1, -1] as const) {
            const strength = input(direction);
            strength.daily = strength.daily.map((bar, i) => {
                const close = 100 + direction * i * 0.2;
                return { ...bar, open: close - direction * 0.1, high: close + 1.5, low: close - 1.5, close };
            });
            const previous = strength.daily.at(-1)!.close;
            strength.contract.reference = previous;
            const price = previous + direction * 0.5;
            Object.assign(strength.snapshot!, { open: previous, close: price,
                high: Math.max(previous, price) + 0.1, low: Math.min(previous, price) - 0.1,
                buy_price: price - 0.05, sell_price: price + 0.05 });
            expect(failure(strength)).toContain(direction === 1 ? 'RSI > 85' : 'RSI < 15');

            const stretched = input(direction);
            const stretchedPrice = stretched.daily.at(-1)!.close * (direction === 1 ? 1.25 : 0.75);
            Object.assign(stretched.snapshot!, { close: stretchedPrice,
                high: Math.max(stretched.snapshot!.open, stretchedPrice) + 0.1,
                low: Math.min(stretched.snapshot!.open, stretchedPrice) - 0.1,
                buy_price: stretchedPrice - 0.05, sell_price: stretchedPrice + 0.05 });
            expect(failure(stretched)).toContain(direction === 1 ? '正乖離 > 15%' : '負乖離 < -15%');
        }
    });

    it('checks the 3-day 22% rule without substituting a 3-bar current-session return', () => {
        for (const direction of [1, -1] as const) {
            const value = input(direction);
            const price = direction === 1 ? 132 : 75;
            const previous = direction === 1 ? 130 : 76;
            const recent = [price / (direction === 1 ? 1.22 : 0.78), direction === 1 ? 125 : 79, previous];
            for (let i = 0; i < 3; i++) {
                const close = recent[i]!;
                Object.assign(value.daily.at(-3 + i)!, { open: close, close, high: close + 1.5, low: close - 1.5 });
            }
            value.contract.reference = previous;
            value.contract.limit_up = previous * 1.1;
            value.contract.limit_down = previous * 0.9;
            Object.assign(value.snapshot!, { open: previous, close: price,
                high: Math.max(previous, price) + 0.1, low: Math.min(previous, price) - 0.1,
                buy_price: price - 0.05, sell_price: price + 0.05 });
            expect(failure(value)).toContain(direction === 1 ? '3 日漲幅 ≥ 22%' : '3 日跌幅 ≥ 22%');
        }
    });

    it('flat price RSI is neutral; missing/zero history is never imputed as an attractive score', () => {
        const value = input();
        value.daily = value.daily.map(bar => ({ ...bar, open: 100, high: 101.5, low: 98.5, close: 100 }));
        value.contract.reference = 100;
        expect(failure(value)).toContain('趨勢未形成');
        value.daily[10]!.close = 0;
        expect(failure(value)).toContain('格式');
    });

    it('requires validated daily units, turnover, ATR and enough sorted daily history', () => {
        const small = input();
        small.daily = small.daily.map(bar => ({ ...bar, volume: 10 }));
        expect(failure(small)).toContain('不足 1 億');
        const narrow = input();
        narrow.daily = narrow.daily.map(bar => ({ ...bar, high: Math.max(bar.open, bar.close) + 0.01,
            low: Math.min(bar.open, bar.close) - 0.01 }));
        expect(failure(narrow)).toContain('波幅');
        const tooFew = input();
        tooFew.daily = tooFew.daily.slice(-21);
        expect(failure(tooFew)).toContain('不足 22');
        const unordered = input();
        [unordered.daily[0], unordered.daily[1]] = [unordered.daily[1]!, unordered.daily[0]!];
        expect(failure(unordered)).toContain('順序');
    });

    it('returns closed and preopen observations without labelling them currently tradable', () => {
        for (const time of ['08:30:00', '14:00:00']) {
            const result = evaluateDaytrade([input()], now(time));
            expect(result.long).toHaveLength(0);
            expect(result.short).toHaveLength(0);
            expect(result.observationsLong).toHaveLength(1);
            expect(result.phase).toBe(time === '08:30:00' ? 'preopen' : 'closed');
            expect(result.excluded[0]!.reasons.join(' ')).toMatch(/尚未進入|時段已結束/);
        }
        expect(failure(input(), now('13:26:00'))).toContain('時段已結束');
    });

    it('does not confirm weekend trading just because synthetic data and clock match', () => {
        const value = input();
        value.contract.update_date = '2026-10-10';
        const result = evaluateDaytrade([value], Date.parse('2026-10-10T09:40:30+08:00'));
        expect(result.phase).toBe('closed');
        expect(result.long).toHaveLength(0);
    });

    it('caps each side at ten, respects the forty-stock input scope, deduplicates codes and never pads', () => {
        const values = Array.from({ length: 30 }, (_, i) => input(i < 15 ? 1 : -1, String(2000 + i)));
        const result = evaluateDaytrade(values, now());
        expect(result.long).toHaveLength(10);
        expect(result.short).toHaveLength(10);
        expect(result.observationsLong).toHaveLength(10);
        expect(result.observationsShort).toHaveLength(10);
        expect(new Set([...result.long, ...result.short].map(row => row.contract.code)).size).toBe(20);
        expect(evaluateDaytrade([input(), input()], now()).long).toHaveLength(1);
        const missing = input();
        missing.snapshot = undefined;
        expect(evaluateDaytrade([missing], now()).long).toHaveLength(0);
        const oversized = Array.from({ length: 40 }, (_, i) => ({ ...input(1, String(3000 + i)), minutes: [] }));
        expect(evaluateDaytrade([...oversized, input()], now()).long).toHaveLength(0);
        expect(DAYTRADE_DEFAULTS.maxPool).toBe(40);
    });

    it('uses stable code ordering for tied scores and adds no relative-index points when data is missing', () => {
        const missing = evaluateDaytrade([input(1, '2331'), input(1, '2330')], now());
        const withIndex = evaluateDaytrade([input(1, '2330')], now(), 0);
        expect(missing.long.map(row => row.contract.code)).toEqual(['2330', '2331']);
        expect(withIndex.long[0]!.score).toBe(missing.long[0]!.score + 10);
        expect(missing.long[0]!.reasons.join(' ')).toContain('指數即時方向資料不足');
    });

    it('requires a finite evaluation clock', () => {
        expect(() => evaluateDaytrade([], Number.NaN)).toThrow('finite');
    });

    it('isolates the optional research RVOL threshold without changing the default or other guards', () => {
        const value = input();
        expect(evaluateDaytrade([value], now(), undefined, { minimumRvol: 1.5 }))
            .toEqual(evaluateDaytrade([value], now()));
        expect(evaluateDaytrade([value], now(), undefined, { minimumRvol: 2 }).long).toHaveLength(1);
        expect(evaluateDaytrade([value], now(), undefined, { minimumRvol: 2.5 }).long).toHaveLength(0);
        value.snapshot!.buy_volume = 0;
        expect(evaluateDaytrade([value], now(), undefined, { minimumRvol: 1.5 }).long).toHaveLength(0);
        for (const minimumRvol of [0, 1, 1.49, 1.6, 3, Number.NaN]) {
            expect(() => evaluateDaytrade([], now(), undefined, { minimumRvol })).toThrow('minimumRvol');
        }
    });

    it('does not rank stale previous-session history with fresh qualification metadata', () => {
        const value = input();
        value.daily = value.daily.map(bar => ({ ...bar, time: bar.time - 7 * day }));
        expect(failure(value)).toContain('超過 7');
        expect(evaluateDaytrade([value], now()).observationsLong).toHaveLength(0);
    });

    it('rejects fresh-price / historical-close mismatch until corporate actions or stale data are resolved', () => {
        const value = input();
        value.contract.reference = value.daily.at(-1)!.close * 0.95;
        expect(failure(value)).toContain('除權息');
        expect(evaluateDaytrade([value], now()).long).toHaveLength(0);
        value.contract.reference = 0;
        expect(failure(value)).toContain('參考價');
    });

    it('does not confirm RVOL using ancient complete sessions outside the recent 20 daily labels', () => {
        const value = input();
        value.minutes = value.minutes.map(bar => bar.time < today ? { ...bar, time: bar.time - 80 * day } : bar);
        expect(failure(value)).toContain('不足 14');
        expect(evaluateDaytrade([value], now()).long).toHaveLength(0);
    });

    it('does not count weekend minute prefixes as trading sessions', () => {
        const value = input();
        const ancient = value.daily.at(-14)!.time;
        value.minutes = value.minutes.filter(bar => bar.time < ancient || bar.time >= ancient + day);
        const saturday = Date.parse('2026-10-03T00:00:00Z') / 1_000;
        value.minutes.push(...session(saturday, value.daily.at(-1)!.close, 1));
        expect(failure(value)).toContain('不足 14');
    });

    it('does not promote the real no-offset short-source wire timestamp without timezone verification', () => {
        const value = input(-1);
        value.shortSource = { quantity: 1121, datetime: '2026-10-07T04:49:22' };
        expect(failure(value)).toContain('可供券');
        expect(evaluateDaytrade([value], now()).short).toHaveLength(0);
    });

    it('accepts the exact 0.5% reference mismatch boundary despite floating-point noise', () => {
        const value = input();
        value.contract.reference = value.daily.at(-1)!.close / 1.005;
        expect(evaluateDaytrade([value], now()).long).toHaveLength(1);
    });

    it('does not silently discard an unparseable daily label and rank the remaining tail', () => {
        const value = input();
        value.daily[5]!.time = Number.NaN;
        expect(failure(value)).toContain('日期不明');
    });
});
