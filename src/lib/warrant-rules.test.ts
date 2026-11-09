// 台灣權證交易規則（來源與條號見 docs/qa/warrant-rules.md）。
// 每一條 describe 對應文件中的一條規則；改規則時文件與測試一起改。
import { describe, expect, it } from 'vitest';
import { contractMarket, isForeignUnderlyingWarrant, isWarrantCode, isWarrantContract } from './contract-market';
import { WARRANT_TEXT, WARRANT_UNITS_PER_LOT, warrantMarketOrderBlock, warrantOrderProblem } from './warrant-rules';
import { roundToTick, stepPrice, tickSizeFor } from './utils/ticksize';
import type { ContractBase } from './types/contract';

const twse = { code: '030392', security_type: 'WRT', exchange: 'TSE', target_code: null } as ContractBase;
const tpex = { code: '700001', security_type: 'WRT', exchange: 'OTC', target_code: null } as ContractBase;
const stkTyped = { ...twse, security_type: 'STK' } as ContractBase;
const foreignCall = { ...twse, code: '03001F' } as ContractBase;
const foreignPut = { ...tpex, code: '70001Q' } as ContractBase;
const stock = { code: '2330', security_type: 'STK', exchange: 'TSE', target_code: null } as ContractBase;

describe('規則 1：權證升降單位（TWSE 權證買賣辦法第 6 條；櫃買權證升降單位表）', () => {
    // [價格, 權證跳動]：每個級距的下緣與上緣前一檔
    const table: [number, number][] = [
        [0.01, 0.01], [4.99, 0.01],
        [5, 0.05], [9.95, 0.05],
        [10, 0.1], [49.9, 0.1],
        [50, 0.5], [99.5, 0.5],
        [100, 1], [499, 1],
        [500, 5], [1000, 5],
    ];
    it.each([['上市', twse], ['上櫃', tpex], ['標成 STK 的權證', stkTyped]] as const)('%s權證各級距', (_n, c) => {
        for (const [price, tick] of table) expect(tickSizeFor(c, price)).toBe(tick);
    });

    it('與股票表不同：5–10 元股票 0.01、權證 0.05；500–1000 元股票 1、權證 5', () => {
        expect(tickSizeFor(stock, 7)).toBe(0.01);
        expect(tickSizeFor(twse, 7)).toBe(0.05);
        expect(tickSizeFor(stock, 600)).toBe(1);
        expect(tickSizeFor(twse, 600)).toBe(5);
    });

    it.each([['上市', twse], ['上櫃', tpex]] as const)('%s權證：價格階梯跨級距往上', (_n, c) => {
        expect(stepPrice(c, 4.98, 1)).toBe(4.99);
        expect(stepPrice(c, 4.99, 1)).toBe(5);
        expect(stepPrice(c, 5, 1)).toBe(5.05);
        expect(stepPrice(c, 9.95, 1)).toBe(10);
        expect(stepPrice(c, 10, 1)).toBe(10.1);
        expect(stepPrice(c, 49.9, 1)).toBe(50);
        expect(stepPrice(c, 50, 1)).toBe(50.5);
        expect(stepPrice(c, 99.5, 1)).toBe(100);
        expect(stepPrice(c, 100, 1)).toBe(101);
        expect(stepPrice(c, 499, 1)).toBe(500);
        expect(stepPrice(c, 500, 1)).toBe(505);
    });

    it.each([['上市', twse], ['上櫃', tpex]] as const)('%s權證：價格階梯跨級距往下（用下方級距的跳動）', (_n, c) => {
        expect(stepPrice(c, 5.05, -1)).toBe(5);
        expect(stepPrice(c, 5, -1)).toBe(4.99);
        expect(stepPrice(c, 10.1, -1)).toBe(10);
        expect(stepPrice(c, 10, -1)).toBe(9.95);
        expect(stepPrice(c, 50, -1)).toBe(49.9);
        expect(stepPrice(c, 100, -1)).toBe(99.5);
        expect(stepPrice(c, 500, -1)).toBe(499);
        expect(stepPrice(c, 505, -1)).toBe(500);
    });

    it('多檔連跳也逐檔換級距', () => {
        expect(stepPrice(twse, 4.98, 4)).toBe(5.1);
        expect(stepPrice(twse, 5.1, -4)).toBe(4.98);
    });

    it('吸附到權證檔位', () => {
        expect(roundToTick(twse, 7.03)).toBe(7.05);
        expect(roundToTick(twse, 12.34)).toBe(12.3);
        expect(roundToTick(twse, 512)).toBe(510);
    });
});

describe('規則 2：交易單位 1,000 權證單位（TWSE 權證買賣辦法第 5 條）', () => {
    it('一張 1,000 單位，與股票同一條證券下單路徑', () => {
        expect(WARRANT_UNITS_PER_LOT).toBe(1000);
        expect(contractMarket('WRT')).toBe('S');
    });
});

describe('規則 3：權證不得零股交易（TWSE／櫃買交易制度：認購(售)權證及 ETN 不得進行零股交易）', () => {
    it.each(['IntradayOdd', 'Odd'])('%s 一律擋下', (lot) => {
        for (const c of [twse, tpex, stkTyped]) {
            expect(warrantOrderProblem(c, { price_type: 'LMT', order_lot: lot })).toBe(WARRANT_TEXT.oddLot);
        }
    });

    it('整股照常', () => {
        expect(warrantOrderProblem(twse, { price_type: 'LMT', order_lot: 'Common' })).toBeNull();
    });

    it('股票不受影響', () => {
        expect(warrantOrderProblem(stock, { price_type: 'LMT', order_lot: 'IntradayOdd' })).toBeNull();
    });
});

describe('規則 4：外國標的權證無漲跌幅，不收市價（買賣辦法第 7 條＋營業細則第 58 條之 8）', () => {
    it('第六碼 F／Q 是外國標的', () => {
        expect(isForeignUnderlyingWarrant('03001F')).toBe(true);
        expect(isForeignUnderlyingWarrant('70001Q')).toBe(true);
        expect(isForeignUnderlyingWarrant('030392')).toBe(false);
        expect(isForeignUnderlyingWarrant('03001P')).toBe(false);
    });

    it.each([['認購', foreignCall], ['認售', foreignPut]] as const)('外國標的%s：市價擋下、限價可以', (_n, c) => {
        expect(warrantMarketOrderBlock(c)).toBe(WARRANT_TEXT.foreignMarket);
        expect(warrantOrderProblem(c, { price_type: 'MKT', order_lot: 'Common' })).toBe(WARRANT_TEXT.foreignMarket);
        expect(warrantOrderProblem(c, { price_type: 'LMT', order_lot: 'Common' })).toBeNull();
    });

    it('標成 STK 的外國標的權證同樣擋下', () => {
        expect(warrantMarketOrderBlock({ ...foreignCall, security_type: 'STK' })).toBe(WARRANT_TEXT.foreignMarket);
    });

    it('國內標的權證有漲跌幅：市價可以', () => {
        for (const c of [twse, tpex, stkTyped]) {
            expect(warrantMarketOrderBlock(c)).toBeNull();
            expect(warrantOrderProblem(c, { price_type: 'MKT', order_lot: 'Common' })).toBeNull();
        }
    });
});

describe('規則 5：委託效期 ROD／IOC／FOK 與股票相同（營業細則第 58 條之 8）', () => {
    it('權證規則不另外限制效期', () => {
        // 效期不在 warrantOrderProblem 的判斷內：ROD/IOC/FOK 一律交由股票規則
        for (const price_type of ['LMT', 'MKT']) {
            expect(warrantOrderProblem(twse, { price_type, order_lot: 'Common' })).toBeNull();
        }
    });
});

describe('規則 6：權證只能現股（未列入融資融券、現股當沖標的；保守停用）', () => {
    it.each(['MarginTrading', 'ShortSelling', 'SBLShort', 'SBLShortPriceExempt'])('%s 擋下', (cond) => {
        expect(warrantOrderProblem(twse, { price_type: 'LMT', order_lot: 'Common', order_cond: cond })).toBe(WARRANT_TEXT.credit);
    });

    it('現股當沖先賣擋下', () => {
        expect(warrantOrderProblem(twse, { price_type: 'LMT', order_lot: 'Common', order_cond: 'Cash', daytrade_short: true })).toBe(WARRANT_TEXT.credit);
    });
});

describe('權證代號判斷（O-001 T30 表二 證券種類代碼）', () => {
    it.each(['030000', '089999', '03000P', '08999U', '03000T', '03000C', '03000B', '03000X', '03000Y', '700000', '739999', '70000P', '73999Q'])('%s 是權證', (code) => {
        expect(isWarrantCode(code)).toBe(true);
    });

    it.each(['2330', '0050', '00878', '020000', '090000', '740000', '233011', '03000Z', '0300001', ''])('%s 不是權證', (code) => {
        expect(isWarrantCode(code)).toBe(false);
    });

    it('WRT 一定是；STK 看代號；期權、指數不看代號', () => {
        expect(isWarrantContract({ security_type: 'WRT', code: 'ANY' })).toBe(true);
        expect(isWarrantContract({ security_type: 'STK', code: '030392' })).toBe(true);
        expect(isWarrantContract({ security_type: 'STK', code: '2330' })).toBe(false);
        expect(isWarrantContract({ security_type: 'FUT', code: '030392' })).toBe(false);
        expect(isWarrantContract(undefined)).toBe(false);
    });
});
