// #403 當日虧損上限 vs background opening entries: the engine's rule, checked
// when a trigger is created instead of refused when it fires.
import { describe, expect, it } from 'vitest';
import { backgroundEntryLossLimitProblem, dailyLossLimitSet, LOSS_LIMIT_FUTURES_TEXT, LOSS_LIMIT_STOCK_TEXT, pnlAccountOf } from './background-loss-limit';

const ON = { enabled: true, maxDailyLoss: 5000 };
const S = { accountType: 'S' as const, brokerId: 'b', accountId: 's1' };
const F = { accountType: 'F' as const, brokerId: 'b', accountId: 'f1' };
const PNL = { brokerId: 'b', accountId: 'f1' };

describe('backgroundEntryLossLimitProblem', () => {
    it('a stock opening entry is refused while risk is on with a limit above 0', () => {
        expect(backgroundEntryLossLimitProblem({ opens: true, account: S }, ON, PNL)).toBe(LOSS_LIMIT_STOCK_TEXT);
        expect(backgroundEntryLossLimitProblem({ opens: true, account: S }, ON, null)).toBe(LOSS_LIMIT_STOCK_TEXT);
    });

    it('limit 0 or the risk rules off: nothing refused', () => {
        expect(backgroundEntryLossLimitProblem({ opens: true, account: S }, { enabled: true, maxDailyLoss: 0 }, PNL)).toBeNull();
        expect(backgroundEntryLossLimitProblem({ opens: true, account: S }, { enabled: false, maxDailyLoss: 5000 }, PNL)).toBeNull();
        expect(dailyLossLimitSet({ enabled: false, maxDailyLoss: 5000 })).toBe(false);
    });

    it('an exit / protection (not opening) is never refused', () => {
        expect(backgroundEntryLossLimitProblem({ opens: false, account: S }, ON, PNL)).toBeNull();
        expect(backgroundEntryLossLimitProblem({ opens: false, account: { ...F, accountId: 'f2' } }, ON, PNL)).toBeNull();
    });

    it('futures: the P&L account passes, another futures account is refused, an unknown P&L account is left to the engine', () => {
        expect(backgroundEntryLossLimitProblem({ opens: true, account: F }, ON, PNL)).toBeNull();
        expect(backgroundEntryLossLimitProblem({ opens: true, account: { ...F, accountId: 'f2' } }, ON, PNL)).toBe(LOSS_LIMIT_FUTURES_TEXT);
        expect(backgroundEntryLossLimitProblem({ opens: true, account: { ...F, brokerId: 'c' } }, ON, PNL)).toBe(LOSS_LIMIT_FUTURES_TEXT);
        expect(backgroundEntryLossLimitProblem({ opens: true, account: F }, ON, null)).toBeNull();
    });

    it('reads the P&L account as the engine gets it ("F:<broker>:<account>" only)', () => {
        expect(pnlAccountOf('F:b:f1')).toEqual(PNL);
        expect(pnlAccountOf('S:b:s1')).toBeNull();
        expect(pnlAccountOf(undefined)).toBeNull();
        expect(pnlAccountOf('F:b:')).toBeNull();
    });
});
