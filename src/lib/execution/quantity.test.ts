import { expect, it } from 'vitest';
import { runScenario, type Scenario } from './conformance';
import seed from './scenarios/r38-external-wrong-action.json';
import type { ExecEvent } from './model';

const badQuantities = [1.5, -1, 0, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1];
for (const qty of badQuantities) {
    it(`r38 rejects typed deal quantity ${qty}`, () => {
        const e: ExecEvent = { type:'deal',ts:1790730000005,env:'simulation',serverId:'local-a',
            orderId:'o-entry',seqno:'S1',ordno:'O1',account:{brokerId:'F002000',accountId:'1234567'},
            code:'TXFJ6',securityType:'FUT',action:'Buy',qty,price:100,seq:'1',eventId:'e',fillTs:1790730000.005 };
        expect(runScenario({ ...seed, steps:[...seed.steps.slice(0,3), { event:e,
            expect:{ programs:{b1:{levels:{L1:{entryFilled:0,position:0,orders:[{filled:0,status:'working'}]}}}},intents:[] } }] } as Scenario)).toEqual([]);
    });
    for (const field of ['originalQty','cancelQty'] as const) {
        // Zero cancelled units is legitimate; original order quantity must be positive.
        if (field === 'cancelQty' && qty === 0) continue;
        it(`r38 rejects typed ${field} ${qty} before terminal mutation`, () => {
            const e = { ...seed.steps[3]!.event, action:'Buy',originalQty:2,cancelQty:2,[field]:qty };
            expect(runScenario({ ...seed,steps:[...seed.steps.slice(0,3),{event:e,
                expect:seed.steps[3]!.expect}] } as Scenario)).toEqual([]);
        });
    }
    for (const field of ['qty','cancelled','deals'] as const) {
        if (field === 'cancelled' && qty === 0) continue;
        it(`r38 invalid listing ${field} ${qty} preserves ambiguity`, () => {
            const e = structuredClone(seed.steps[2]!.event);
            const row = (e as {orders:Record<string,unknown>[]}).orders[0]!;
            row.status = 'ended';
            row[field] = field === 'deals' ? [{seq:'1',qty,price:100}] : qty;
            expect(runScenario({ ...seed,steps:[...seed.steps.slice(0,3),{event:e,
                expect:{programs:{b1:{levels:{L1:{entryFilled:0,position:0,orders:[{filled:0,unconfirmed:true,tagAmbiguous:true}]}}}},intents:[]}}] } as Scenario)).toEqual([]);
        });
    }
}
