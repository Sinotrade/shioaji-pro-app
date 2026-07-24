// src/lib/exit-plan.test.ts — 平倉拆腿/終態判定/終態彙總的純函式測試
// 覆蓋 reviewer 點名情境：全成交、部分成交後取消、Filled+Cancelled 混合、
// Failed 混合、第二腿同步失敗；外加「沒送出的腿不得被漏出彙總」的不變式。

import { describe, expect, it } from 'vitest';
import {
    executeExitLegs,
    isTerminal,
    isTerminalTrade,
    planStockExitLegs,
    resolveDealQty,
    summarizeTerminalOutcomes,
    summarizeTimeout,
    tradeToOutcome,
    type ExitLeg,
    type LegError,
    type ExitPlanInput,
    type TradeOutcome,
} from './exit-plan';

const LIMITS = { limit_up: 110, limit_down: 90, day_trade: 'Yes' as const };

const plan = (over: Partial<ExitPlanInput> & { closeShares: number }) =>
    planStockExitLegs({ action: 'Sell', limits: LIMITS, ...over });

function outcome(partial: Partial<TradeOutcome>): TradeOutcome {
    return {
        status: 'Filled',
        orderQty: 1,
        dealQty: 1,
        unit: '張',
        msg: '',
        ...partial,
    };
}

describe('planStockExitLegs — 平倉', () => {
    it('昨日庫存足夠 → 整張 + 零股，無現沖腿', () => {
        const { legs, skipped } = plan({ closeShares: 3500, ydShares: 3500 });
        expect(legs).toEqual([
            { label: '整張', quantity: 3, price: null },
            {
                label: '零股',
                quantity: 500,
                price: 90,
                orderLot: 'IntradayOdd',
            },
        ]);
        expect(skipped).toEqual([]);
    });

    it('賣出超過昨日庫存 → 超出的整張走現沖腿', () => {
        const { legs } = plan({ closeShares: 5000, ydShares: 2000 });
        expect(legs).toEqual([
            { label: '整張', quantity: 2, price: null },
            { label: '現沖', quantity: 3, price: null, daytradeShort: true },
        ]);
    });

    it('全部是今日買進 → 只有現沖腿', () => {
        const { legs } = plan({ closeShares: 2000, ydShares: 0 });
        expect(legs).toEqual([
            { label: '現沖', quantity: 2, price: null, daytradeShort: true },
        ]);
    });

    it('買進方向不受 yd 限制（回補空單無集保問題）', () => {
        const { legs } = plan({
            action: 'Buy',
            closeShares: 2000,
            ydShares: 0,
        });
        expect(legs).toEqual([{ label: '整張', quantity: 2, price: null }]);
    });

    it('零股用漲跌停價當限價：賣→跌停、買→漲停', () => {
        expect(plan({ closeShares: 500, ydShares: 500 }).legs[0]?.price).toBe(
            90,
        );
        expect(
            plan({ action: 'Buy', closeShares: 500, ydShares: 500 }).legs[0]
                ?.price,
        ).toBe(110);
    });
});

// 平倉是降風險動作 —— 送不出去的腿要具名跳過，但不能因此連送得出去的腿都不送，
// 把使用者鎖在部位裡（而且「請改為只賣昨日庫存」在 UI 上沒有對應操作）
describe('planStockExitLegs — 送不出的腿具名跳過，其餘照送', () => {
    it('今日買進含零股 → 只跳過零股部分，整張的今日買進照樣現沖', () => {
        const { legs, skipped } = plan({ closeShares: 2500, ydShares: 1000 });
        expect(legs).toEqual([
            { label: '整張', quantity: 1, price: null },
            { label: '現沖', quantity: 1, price: null, daytradeShort: true },
        ]);
        expect(skipped).toHaveLength(1);
        expect(skipped[0]?.error).toMatch(/今日買進 1500 股含 500 股零股/);
    });

    it('不可現沖（day_trade=No）→ 跳過現沖腿，昨日庫存仍然賣得掉', () => {
        const { legs, skipped } = plan({
            closeShares: 3000,
            ydShares: 1000,
            limits: { ...LIMITS, day_trade: 'No' },
        });
        expect(legs).toEqual([{ label: '整張', quantity: 1, price: null }]);
        expect(skipped).toHaveLength(1);
        expect(skipped[0]?.leg).toBe('現沖');
        expect(skipped[0]?.error).toMatch(/不可現股當沖/);
        expect(skipped[0]?.sent).toBe('no');
    });

    it.each(['No', 'OnlyBuy', ''] as const)(
        'day_trade=%s 一律跳過現沖腿（OnlyBuy 只能先買後賣，當沖賣正是先賣）',
        (dt) => {
            const { skipped } = plan({
                closeShares: 3000,
                ydShares: 1000,
                limits: { ...LIMITS, day_trade: dt },
            });
            expect(skipped.map((s) => s.leg)).toContain('現沖');
        },
    );

    it('day_trade 未提供 → 保守當作不可現沖', () => {
        const { skipped } = plan({
            closeShares: 3000,
            ydShares: 1000,
            limits: { limit_up: 110, limit_down: 90 },
        });
        expect(skipped.map((s) => s.leg)).toContain('現沖');
    });

    it('只賣昨日庫存（不需要現沖腿）→ day_trade=No 也照賣，不得跳過', () => {
        const { legs, skipped } = plan({
            closeShares: 2000,
            ydShares: 2000,
            limits: { ...LIMITS, day_trade: 'No' },
        });
        expect(legs).toEqual([{ label: '整張', quantity: 2, price: null }]);
        expect(skipped).toEqual([]);
    });

    it('取不到漲跌停價 → 只跳過零股腿，整張照送', () => {
        const { legs, skipped } = plan({
            closeShares: 1500,
            ydShares: 1500,
            limits: { day_trade: 'Yes' },
        });
        expect(legs).toEqual([{ label: '整張', quantity: 1, price: null }]);
        expect(skipped[0]?.leg).toBe('零股');
    });

    it.each([
        ['ShortSelling', '融券'],
        ['MarginTrading', '融資'],
    ])('%s 部位 → 一腿都不送（現股單不會回補信用部位）', (cond, label) => {
        const { legs, skipped } = plan({
            closeShares: 2000,
            ydShares: 2000,
            cond,
        });
        expect(legs).toEqual([]);
        expect(skipped).toHaveLength(1);
        expect(skipped[0]?.error).toContain(label);
        expect(skipped[0]?.sent).toBe('no');
    });

    // Netting＝現股當沖，正是本功能自己用 daytrade_short 開出來的部位；
    // 擋掉它等於盤中平不掉當沖單（收盤前平不掉會被強制回補）
    it.each(['Cash', 'Netting', 'Emerging'])(
        'cond=%s 是現股交割 → 一律放行，正常拆腿',
        (cond) => {
            const { legs, skipped } = plan({
                closeShares: 2000,
                ydShares: 2000,
                cond,
            });
            expect(legs).toHaveLength(1);
            expect(skipped).toEqual([]);
        },
    );

    it('cond 未提供 → 放行（後端不一定會填這個欄位）', () => {
        const { legs, skipped } = plan({ closeShares: 2000, ydShares: 2000 });
        expect(legs).toHaveLength(1);
        expect(skipped).toEqual([]);
    });
});

describe('planStockExitLegs — 反手', () => {
    it('全為昨日庫存的反手 → 平倉腿走普通、新開空單走現沖', () => {
        const { legs } = plan({
            closeShares: 2000,
            openShares: 2000,
            ydShares: 2000,
        });
        expect(legs).toEqual([
            { label: '整張', quantity: 2, price: null },
            { label: '現沖', quantity: 2, price: null, daytradeShort: true },
        ]);
    });

    it('今日買進 + 反手 → 兩者合併成同一現沖腿', () => {
        const { legs } = plan({
            closeShares: 2000,
            openShares: 2000,
            ydShares: 1000,
        });
        expect(legs).toEqual([
            { label: '整張', quantity: 1, price: null },
            { label: '現沖', quantity: 3, price: null, daytradeShort: true },
        ]);
    });

    it('全為昨日庫存的零股反手 → 訊息不得誣指「今日買進」', () => {
        // 今日一股都沒買，卡住的是新開空單裡的零股；叫使用者留倉隔日再賣是
        // 錯誤指引（那些零股是昨日庫存，用「平」今天就賣得掉）
        const { skipped } = plan({
            closeShares: 1500,
            openShares: 1500,
            ydShares: 1500,
        });
        expect(skipped[0]?.error).toMatch(/反手新空單 1500 股含 500 股零股/);
        expect(skipped[0]?.error).not.toContain('今日買進');
        expect(skipped[0]?.error).not.toContain('留倉隔日');
    });

    it('反手做多（回補空單再翻多）不受 yd 限制，全走普通現股', () => {
        const { legs } = plan({
            action: 'Buy',
            closeShares: 2000,
            openShares: 2000,
            ydShares: 0,
        });
        expect(legs).toEqual([{ label: '整張', quantity: 4, price: null }]);
    });

    it('拆腿數量與舊式 max(0, close+open-yd) 等價（yd <= close 恆成立）', () => {
        for (const close of [1000, 2000, 5000, 10000]) {
            for (const yd of [0, 1000, 2000, 5000]) {
                if (yd > close) continue;
                for (const open of [0, close]) {
                    const { legs } = plan({
                        closeShares: close,
                        openShares: open,
                        ydShares: yd,
                    });
                    const dt =
                        legs.find((l) => l.label === '現沖')?.quantity ?? 0;
                    expect(dt * 1000).toBe(Math.max(0, close + open - yd));
                }
            }
        }
    });
});

describe('executeExitLegs', () => {
    const legs: ExitLeg[] = [
        { label: '整張', quantity: 2, price: null },
        { label: '現沖', quantity: 1, price: null, daytradeShort: true },
        { label: '零股', quantity: 500, price: 90, orderLot: 'IntradayOdd' },
    ];

    it('全部送出成功 → placed 齊、errors 空', async () => {
        const { placed, errors } = await executeExitLegs(legs, (leg) =>
            Promise.resolve(`id-${leg.label}`),
        );
        expect(placed).toEqual(['id-整張', 'id-現沖', 'id-零股']);
        expect(errors).toEqual([]);
    });

    it('第二腿同步失敗 → 不 throw，第一腿保留、第三腿照送、失敗腿記名', async () => {
        const { placed, errors } = await executeExitLegs(legs, (leg) =>
            leg.label === '現沖'
                ? Promise.reject(new Error('連線逾時'))
                : Promise.resolve(`id-${leg.label}`),
        );
        expect(placed).toEqual(['id-整張', 'id-零股']);
        // 送出時炸掉無從得知券商收到沒有 → sent:'unknown'（與刻意跳過相反）
        expect(errors).toEqual([
            { leg: '現沖', error: '連線逾時', sent: 'unknown' },
        ]);
    });

    it('全部失敗 → placed 空、每腿都有 error', async () => {
        const { placed, errors } = await executeExitLegs(legs, () =>
            Promise.reject(new Error('斷線')),
        );
        expect(placed).toEqual([]);
        expect(errors.map((e) => e.leg)).toEqual(['整張', '現沖', '零股']);
    });
});

describe('isTerminal', () => {
    const check = (partial: Partial<Parameters<typeof isTerminal>[0]>) =>
        isTerminal({
            status: 'Submitted',
            orderQty: 3,
            dealQty: 0,
            cancelQty: 0,
            ...partial,
        });

    it.each(['Filled', 'Failed', 'Cancelled', 'Inactive'] as const)(
        '%s 是終態',
        (status) => {
            expect(check({ status })).toBe(true);
        },
    );

    it.each(['Submitted', 'PreSubmitted', 'PendingSubmit'] as const)(
        '%s 不是終態',
        (status) => {
            expect(check({ status })).toBe(false);
        },
    );

    it('PartFilled 且成交+取消已涵蓋委託量 → 終態（部分成交後取消）', () => {
        expect(
            check({
                status: 'PartFilled',
                orderQty: 3,
                dealQty: 1,
                cancelQty: 2,
            }),
        ).toBe(true);
    });

    it('PartFilled 但還有餘量在撮合 → 不是終態（零股 ROD 腿不可提早定案）', () => {
        expect(
            check({
                status: 'PartFilled',
                orderQty: 3,
                dealQty: 1,
                cancelQty: 0,
            }),
        ).toBe(false);
    });
});

describe('resolveDealQty', () => {
    it('deal_quantity 尚未結算但 deals 已有明細 → 取 deals 加總', () => {
        expect(
            resolveDealQty({
                deal_quantity: 0,
                deals: [{ quantity: 2 }, { quantity: 1 }],
            }),
        ).toBe(3);
    });

    it('沒有 deals → 用 deal_quantity', () => {
        expect(resolveDealQty({ deal_quantity: 2 })).toBe(2);
    });

    it('deal_quantity 為 null/undefined → 不得當成 NaN', () => {
        expect(resolveDealQty({ deal_quantity: null })).toBe(0);
        expect(resolveDealQty({})).toBe(0);
    });

    it('兩者都有 → 取較大者（結算落後時不低報）', () => {
        expect(
            resolveDealQty({ deal_quantity: 3, deals: [{ quantity: 1 }] }),
        ).toBe(3);
    });
});

describe('summarizeTerminalOutcomes', () => {
    it('每腿 Filled 且足量 → 綠色成交', () => {
        const n = summarizeTerminalOutcomes('2330 平倉', [
            outcome({ orderQty: 3, dealQty: 3 }),
            outcome({ orderQty: 500, dealQty: 500, unit: '股' }),
        ]);
        expect(n.kind).toBe('ok');
        expect(n.title).toContain('全部成交');
    });

    it('部分成交後取消（Cancelled 但 dealt>0）→ 紅色部分成交，非綠色', () => {
        const n = summarizeTerminalOutcomes('2330 平倉', [
            outcome({ status: 'Cancelled', orderQty: 3, dealQty: 1 }),
        ]);
        expect(n.kind).toBe('err');
        expect(n.title).toContain('部分成交');
        expect(n.body).toContain('1/3');
    });

    it('PartFilled 終態（部分成交後取消餘量）→ 紅色附中文狀態', () => {
        const n = summarizeTerminalOutcomes('2330 平倉', [
            outcome({ status: 'PartFilled', orderQty: 3, dealQty: 1 }),
        ]);
        expect(n.kind).toBe('err');
        expect(n.body).toContain('部分成交 1/3');
    });

    it('Filled + Cancelled 混合 → 紅色部分成交附各腿明細', () => {
        const n = summarizeTerminalOutcomes('2330 平倉', [
            outcome({ orderQty: 2, dealQty: 2 }),
            outcome({
                status: 'Cancelled',
                orderQty: 500,
                dealQty: 0,
                unit: '股',
            }),
        ]);
        expect(n.kind).toBe('err');
        expect(n.title).toContain('部分成交');
        expect(n.body).toContain('2/2 張');
        expect(n.body).toContain('0/500 股');
    });

    it('Failed 混合（一腿成交一腿退件）→ 紅色，附退件原因', () => {
        const n = summarizeTerminalOutcomes('2330 平倉', [
            outcome({ orderQty: 2, dealQty: 2 }),
            outcome({
                status: 'Failed',
                orderQty: 1,
                dealQty: 0,
                msg: '集保賣出餘股數不足',
            }),
        ]);
        expect(n.kind).toBe('err');
        expect(n.body).toContain('集保賣出餘股數不足');
    });

    it('全退件（零成交）→ 退件通知附原因', () => {
        const n = summarizeTerminalOutcomes('2330 平倉', [
            outcome({ status: 'Failed', dealQty: 0, msg: '餘股不足' }),
        ]);
        expect(n.kind).toBe('err');
        expect(n.title).toContain('退件');
        expect(n.body).toBe('餘股不足');
    });

    it('整筆取消零成交（市價 IOC 遇薄簿）→ 紅色並列出數量，不可用中性帶過', () => {
        const n = summarizeTerminalOutcomes('2330 平倉', [
            outcome({ status: 'Cancelled', orderQty: 3, dealQty: 0 }),
        ]);
        expect(n.kind).toBe('err');
        expect(n.title).toContain('未成交');
        expect(n.body).toContain('0/3 張');
        expect(n.body).toContain('持倉完全未處理');
    });

    it('Inactive 視同退件終態（不會被當成交或掛著逾時）', () => {
        const n = summarizeTerminalOutcomes('2330 平倉', [
            outcome({ status: 'Inactive', dealQty: 0, msg: '' }),
        ]);
        expect(n.kind).toBe('err');
        expect(n.body).toContain('Inactive');
    });

    it('Filled 但量不足（防禦）→ 也算部分成交，不報綠', () => {
        const n = summarizeTerminalOutcomes('2330 平倉', [
            outcome({ orderQty: 3, dealQty: 2 }),
        ]);
        expect(n.kind).toBe('err');
        expect(n.title).toContain('部分成交');
    });

    it('Filled 但成交量 0（回報自相矛盾）→ 不得說「未成交」', () => {
        const n = summarizeTerminalOutcomes('2330 平倉', [
            outcome({ status: 'Filled', orderQty: 500, dealQty: 0, unit: '股' }),
        ]);
        expect(n.kind).toBe('err');
        expect(n.title).toContain('無法確認成交數量');
        expect(n.body).not.toContain('未成交');
    });
});

// reviewer 第 1 點的修法（送出失敗的腿不再 throw、單獨記名）不可以把第 2 點
// 從側門放回來：只把「送出成功的腿」餵進彙總，every() 會對縮小過的集合成立，
// 於是「整張腿全成交 + 現沖腿沒送出去」會報綠色「全部成交」，而部位只平了一半。
describe('summarizeTerminalOutcomes — 未送出的腿必須進入判讀', () => {
    const unsent: LegError[] = [
        { leg: '現沖', error: '超過單筆上限', sent: 'unknown' },
    ];

    it('已送出的腿全部足額成交，但有腿沒送出 → 絕不可報綠色全部成交', () => {
        const n = summarizeTerminalOutcomes(
            '2454 平倉',
            [outcome({ orderQty: 3, dealQty: 3 })],
            unsent,
        );
        expect(n.kind).toBe('err');
        expect(n.title).not.toContain('全部成交');
        expect(n.body).toContain('現沖');
        expect(n.body).toContain('超過單筆上限');
    });

    it('沒有任何腿送出成功 → 明講一筆都沒送出，不是「已取消」', () => {
        const n = summarizeTerminalOutcomes('2454 平倉', [], unsent);
        expect(n.kind).toBe('err');
        expect(n.title).toContain('沒有任何委託送出');
        expect(n.body).toContain('超過單筆上限');
    });

    it('不變式：只要有腿未送出，任何 outcomes 組合都不得回 ok', () => {
        const combos: TradeOutcome[][] = [
            [outcome({ orderQty: 1, dealQty: 1 })],
            [
                outcome({ orderQty: 2, dealQty: 2 }),
                outcome({ orderQty: 1, dealQty: 1 }),
            ],
            [outcome({ status: 'Cancelled', orderQty: 3, dealQty: 1 })],
            [outcome({ status: 'Failed', dealQty: 0, msg: 'x' })],
            [],
        ];
        for (const c of combos) {
            expect(summarizeTerminalOutcomes('t', c, unsent).kind).not.toBe(
                'ok',
            );
        }
    });

    it('回歸保護：沒有未送出的腿且全部足額成交 → 仍然是綠色', () => {
        const n = summarizeTerminalOutcomes(
            't',
            [outcome({ orderQty: 2, dealQty: 2 })],
            [],
        );
        expect(n.kind).toBe('ok');
    });

    it('端到端：executeExitLegs 的 errors 餵進彙總後不可能產生 ok', async () => {
        const legs: ExitLeg[] = [
            { label: '整張', quantity: 3, price: null },
            { label: '現沖', quantity: 5, price: null, daytradeShort: true },
        ];
        const { placed, errors } = await executeExitLegs(legs, (leg) =>
            leg.label === '現沖'
                ? Promise.reject(new Error('超過單筆上限 3（本筆 5）'))
                : Promise.resolve({ qty: leg.quantity }),
        );
        const n = summarizeTerminalOutcomes(
            '2454 平倉',
            placed.map((p) => outcome({ orderQty: p.qty, dealQty: p.qty })),
            errors,
        );
        expect(n.kind).toBe('err');
        expect(n.title).not.toContain('全部成交');
    });

    it('端到端：拆腿時被跳過的腿同樣不得產生 ok（不可現沖 + 昨日庫存照賣）', async () => {
        const { legs, skipped } = plan({
            closeShares: 3000,
            ydShares: 1000,
            limits: { ...LIMITS, day_trade: 'No' },
        });
        const { placed, errors } = await executeExitLegs(legs, (leg) =>
            Promise.resolve({ qty: leg.quantity }),
        );
        const n = summarizeTerminalOutcomes(
            '2454 平倉',
            placed.map((p) => outcome({ orderQty: p.qty, dealQty: p.qty })),
            [...skipped, ...errors],
        );
        expect(n.kind).toBe('err');
        expect(n.title).not.toContain('全部成交');
        expect(n.body).toContain('不可現股當沖');
    });
});

// watchTradesToTerminal 的接線：單位判定、成交量取值、終態判定
describe('tradeToOutcome / isTerminalTrade（委託回報 → 判讀輸入）', () => {
    const trade = (
        order: Partial<{ quantity: number; order_lot: string }>,
        status: Partial<{
            status: string;
            deal_quantity: number | null;
            cancel_quantity: number | null;
            msg: string;
            deals: { quantity: number }[];
        }>,
    ) =>
        ({
            order: { quantity: 1, ...order },
            status: { status: 'Filled', msg: '', ...status },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any;

    it('股票整張腿 → 單位「張」', () => {
        expect(tradeToOutcome(trade({ quantity: 3 }, {}), 'S').unit).toBe('張');
    });

    it('股票零股腿（IntradayOdd）→ 單位「股」', () => {
        expect(
            tradeToOutcome(trade({ order_lot: 'IntradayOdd' }, {}), 'S').unit,
        ).toBe('股');
    });

    it('期貨帳戶 → 單位「口」，不受 order_lot 影響', () => {
        expect(tradeToOutcome(trade({ quantity: 2 }, {}), 'F').unit).toBe('口');
    });

    it('deal_quantity 未結算但 deals 有明細 → 成交量取 deals', () => {
        const o = tradeToOutcome(
            trade(
                { quantity: 3 },
                { deal_quantity: 0, deals: [{ quantity: 3 }] },
            ),
            'S',
        );
        expect(o.dealQty).toBe(3);
    });

    it('退件原因會被帶出來', () => {
        expect(
            tradeToOutcome(
                trade({}, { status: 'Failed', msg: '集保賣出餘股數不足' }),
                'S',
            ).msg,
        ).toBe('集保賣出餘股數不足');
    });

    it('PartFilled + cancel 補滿委託量 → 終態', () => {
        expect(
            isTerminalTrade(
                trade(
                    { quantity: 3 },
                    {
                        status: 'PartFilled',
                        deal_quantity: 1,
                        cancel_quantity: 2,
                    },
                ),
            ),
        ).toBe(true);
    });

    it('PartFilled 但沒有 cancel_quantity 欄位 → 不算終態（繼續等）', () => {
        expect(
            isTerminalTrade(
                trade(
                    { quantity: 3 },
                    { status: 'PartFilled', deal_quantity: 1 },
                ),
            ),
        ).toBe(false);
    });

    it('Submitted → 不是終態', () => {
        expect(isTerminalTrade(trade({}, { status: 'Submitted' }))).toBe(false);
    });
});

describe('summarizeTimeout', () => {
    it('整段都查不到狀態 → 紅色（不知道比知道失敗更危險），且不得說「仍掛著」', () => {
        const n = summarizeTimeout('2330 平倉', []);
        expect(n.kind).toBe('err');
        expect(n.title).toContain('無法確認委託狀態');
        expect(n.body).not.toContain('仍掛著');
    });

    it('最後已知狀態有退件 → 紅色並列出該狀態，不可說還在撮合', () => {
        const n = summarizeTimeout('2330 平倉', [
            outcome({
                status: 'Failed',
                orderQty: 1,
                dealQty: 0,
                msg: '餘股不足',
            }),
            outcome({
                status: 'Submitted',
                orderQty: 500,
                dealQty: 0,
                unit: '股',
            }),
        ]);
        expect(n.kind).toBe('err');
        expect(n.body).toContain('退件 0/1 張');
        expect(n.title).not.toContain('仍在撮合');
    });

    it('全部仍在委託中且零成交 → 中性「仍在撮合中」附最後狀態', () => {
        const n = summarizeTimeout('2330 平倉', [
            outcome({
                status: 'Submitted',
                orderQty: 500,
                dealQty: 0,
                unit: '股',
            }),
        ]);
        expect(n.kind).toBe('info');
        expect(n.title).toContain('仍在撮合中');
        expect(n.body).toContain('委託中 0/500 股');
    });

    it('有腿未送出 → 即使在途腿看起來正常也升級為紅色', () => {
        const n = summarizeTimeout(
            '2330 平倉',
            [outcome({ status: 'Submitted', orderQty: 1, dealQty: 0 })],
            [{ leg: '現沖', error: '斷線', sent: 'unknown' }],
        );
        expect(n.kind).toBe('err');
        expect(n.body).toContain('現沖');
    });

    it('期貨單位用「口」不會被誤標成「張」', () => {
        const n = summarizeTimeout('TXF 平倉', [
            outcome({
                status: 'Submitted',
                orderQty: 2,
                dealQty: 0,
                unit: '口',
            }),
        ]);
        expect(n.body).toContain('0/2 口');
    });
});
