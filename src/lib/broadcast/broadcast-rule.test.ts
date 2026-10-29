import { expect, it } from 'vitest';
import {
    createSymbolState,
    evaluateBroadcast,
    type SymbolBroadcastState,
    type TickSnapshot,
} from './broadcast-rule';

const NO_LIMITS = {};

// 第一筆只定基準不播報（與 WpfApp6 MonitorItemViewModel 相同）
it('does not announce the very first tick', () => {
    const decision = evaluateBroadcast(
        createSymbolState(),
        { price: 100, high: 100, low: 100 },
        NO_LIMITS,
        '台積電',
        { cooldownMs: 4000, now: 1000 },
    );
    expect(decision.speak).toBe(false);
    expect(decision.text).toBe('');
    expect(decision.state.lastPrice).toBe(100);
    // 未播報必須講得出原因（面板的除錯區塊靠它說明為什麼沒聲音）
    expect(decision.reason).toBe('first-tick');
});

it('tells apart the two reasons for not announcing', () => {
    let state: SymbolBroadcastState = createSymbolState();
    const base = { price: 100, high: 100, low: 100 };
    state = evaluateBroadcast(state, base, NO_LIMITS, '台積電', {
        cooldownMs: 4000,
        now: 1000,
    }).state;
    const spoke = evaluateBroadcast(state, base, NO_LIMITS, '台積電', {
        cooldownMs: 4000,
        now: 2000,
    });
    expect(spoke.speak).toBe(true);
    expect(spoke.reason).toBeUndefined();

    // 冷卻擋下 → reason=cooldown
    const blocked = evaluateBroadcast(
        spoke.state,
        { price: 100.5, high: 101, low: 100 },
        NO_LIMITS,
        '台積電',
        { cooldownMs: 4000, now: 2500 },
    );
    expect(blocked.speak).toBe(false);
    expect(blocked.reason).toBe('cooldown');
});

it('announces a new high', () => {
    let state: SymbolBroadcastState = createSymbolState();
    const base = { price: 100, high: 100, low: 100 };
    state = evaluateBroadcast(state, base, NO_LIMITS, '台積電', {
        cooldownMs: 4000,
        now: 1000,
    }).state;
    state = evaluateBroadcast(state, base, NO_LIMITS, '台積電', {
        cooldownMs: 4000,
        now: 2000,
    }).state;

    const decision = evaluateBroadcast(
        state,
        { price: 105, high: 105, low: 100 },
        NO_LIMITS,
        '台積電',
        { cooldownMs: 4000, now: 3000 },
    );
    expect(decision.status).toBe('new-high');
    expect(decision.text).toBe('台積電 105，創新高');
});

it('announces a new low', () => {
    let state: SymbolBroadcastState = createSymbolState();
    const base = { price: 100, high: 100, low: 100 };
    state = evaluateBroadcast(state, base, NO_LIMITS, '台積電', {
        cooldownMs: 4000,
        now: 1000,
    }).state;
    state = evaluateBroadcast(state, base, NO_LIMITS, '台積電', {
        cooldownMs: 4000,
        now: 2000,
    }).state;

    const decision = evaluateBroadcast(
        state,
        { price: 95, high: 100, low: 95 },
        NO_LIMITS,
        '台積電',
        { cooldownMs: 4000, now: 3000 },
    );
    expect(decision.status).toBe('new-low');
    expect(decision.text).toBe('台積電 95，破新低');
});

it('uses chg_type as the authoritative limit-up / limit-down signal', () => {
    let state: SymbolBroadcastState = createSymbolState();
    const base = { price: 100, high: 100, low: 100 };
    state = evaluateBroadcast(state, base, NO_LIMITS, '台積電', {
        cooldownMs: 4000,
        now: 1000,
    }).state;
    state = evaluateBroadcast(state, base, NO_LIMITS, '台積電', {
        cooldownMs: 4000,
        now: 2000,
    }).state;

    const up = evaluateBroadcast(
        state,
        { price: 110, high: 110, low: 100, chgType: 1 },
        NO_LIMITS,
        '台積電',
        { cooldownMs: 4000, now: 3000 },
    );
    expect(up.status).toBe('limit-up');
    expect(up.text).toBe('台積電 110，漲停');

    const down = evaluateBroadcast(
        state,
        { price: 90, high: 100, low: 90, chgType: 5 },
        NO_LIMITS,
        '台積電',
        { cooldownMs: 4000, now: 3000 },
    );
    expect(down.status).toBe('limit-down');
    expect(down.text).toBe('台積電 90，跌停');
});

it('falls back to the limit price when chg_type is absent', () => {
    let state: SymbolBroadcastState = createSymbolState();
    const base = { price: 100, high: 100, low: 100 };
    state = evaluateBroadcast(state, base, NO_LIMITS, '台積電', {
        cooldownMs: 4000,
        now: 1000,
    }).state;
    state = evaluateBroadcast(state, base, NO_LIMITS, '台積電', {
        cooldownMs: 4000,
        now: 2000,
    }).state;

    const decision = evaluateBroadcast(
        state,
        { price: 110, high: 110, low: 100 },
        { limitUp: 110 },
        '台積電',
        { cooldownMs: 4000, now: 3000 },
    );
    expect(decision.status).toBe('limit-up');
});

// 一般播報（沒有狀態詞）受冷卻限制
it('blocks a plain announcement during the cooldown', () => {
    let state: SymbolBroadcastState = createSymbolState();
    const base = { price: 100, high: 100, low: 100 };
    state = evaluateBroadcast(state, base, NO_LIMITS, '台積電', {
        cooldownMs: 4000,
        now: 1000,
    }).state;
    const spoke = evaluateBroadcast(state, base, NO_LIMITS, '台積電', {
        cooldownMs: 4000,
        now: 2000,
    });
    expect(spoke.speak).toBe(true);

    const blocked = evaluateBroadcast(
        spoke.state,
        { price: 100.5, high: 101, low: 100 },
        NO_LIMITS,
        '台積電',
        { cooldownMs: 4000, now: 3000 },
    );
    expect(blocked.speak).toBe(false);
    expect(blocked.text).toBe('');
});

// 有狀態詞 = 重要事件，不受冷卻限制
it('announces an important event even during the cooldown', () => {
    let state: SymbolBroadcastState = createSymbolState();
    const base = { price: 100, high: 100, low: 100 };
    state = evaluateBroadcast(state, base, NO_LIMITS, '台積電', {
        cooldownMs: 4000,
        now: 1000,
    }).state;
    const spoke = evaluateBroadcast(state, base, NO_LIMITS, '台積電', {
        cooldownMs: 4000,
        now: 2000,
    });
    expect(spoke.speak).toBe(true);

    const urgent = evaluateBroadcast(
        spoke.state,
        { price: 110, high: 110, low: 100, chgType: 1 },
        NO_LIMITS,
        '台積電',
        { cooldownMs: 4000, now: 2500 },
    );
    expect(urgent.speak).toBe(true);
    expect(urgent.status).toBe('limit-up');
});

// 被冷卻擋下時，水位標竿仍要跟著市場走，但「上次念出的價格」不動
it('advances the high/low watermark even when the cooldown blocks the speech', () => {
    let state: SymbolBroadcastState = createSymbolState();
    const base = { price: 100, high: 100, low: 100 };
    state = evaluateBroadcast(state, base, NO_LIMITS, '台積電', {
        cooldownMs: 4000,
        now: 1000,
    }).state;
    const spoke = evaluateBroadcast(state, base, NO_LIMITS, '台積電', {
        cooldownMs: 4000,
        now: 2000,
    });
    expect(spoke.speak).toBe(true);

    const blocked = evaluateBroadcast(
        spoke.state,
        { price: 100.5, high: 106, low: 100 },
        NO_LIMITS,
        '台積電',
        { cooldownMs: 4000, now: 3000 },
    );
    expect(blocked.speak).toBe(false);
    expect(blocked.state.lastHigh).toBe(106);
    expect(blocked.state.lastPrice).toBe(100); // 沒念就不更新
});
