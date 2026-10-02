import { describe, expect, it } from 'vitest';
import {
    applyEntryFill,
    bracketPhase,
    protectionQuantity,
    unprotectedQuantity,
    type BracketPlan,
    type FillEvidence,
} from '../bracket-core';
import type { TriggerOrder } from '../trigger-engine';
import { parseEnvKey, programFromBracket, programsFromTriggers } from './adapter';
import { initialState, step } from './core';
import type { EngineState, ExecEvent, OrderIntent, OrderProgram } from './model';

const ENV = 'https://127.0.0.1:9999|simulation';
const account = { account_type: 'F' as const, broker_id: 'F002000', account_id: '1234567' };

function run(events: ExecEvent[], start: EngineState = initialState()) {
    let s = start;
    const intents: OrderIntent[] = [];
    const notices: string[] = [];
    for (const e of events) {
        const r = step(s, e);
        s = r.state;
        intents.push(...r.intents);
        notices.push(...r.notices.map(n => n.code));
    }
    return { state: s, intents, notices };
}

const live = (ts: number): ExecEvent => ({ type: 'connection', ts, live: true, env: 'simulation', serverId: 'https://127.0.0.1:9999' });
const create = (ts: number, program: OrderProgram): ExecEvent => ({ type: 'command', ts, id: `c${ts}`, command: { op: 'create', program } });
const SRC = { env: 'simulation' as const, serverId: 'https://127.0.0.1:9999' };
const tick = (ts: number, price: number, code = 'TXFR1'): ExecEvent => ({ type: 'tick', ts, ...SRC, code, price });

const trigger = (over: Partial<TriggerOrder>): TriggerOrder => ({
    id: 'tg-1', code: 'TXFR1', condition: 'below', price: 100, action: 'Sell', quantity: 2, kind: 'stop',
    env: ENV, account, orderCode: 'TXFJ6', createdAt: 1, ...over,
});

describe('env key', () => {
    it('splits api base and mode', () => {
        expect(parseEnvKey(ENV)).toEqual({ env: 'simulation', serverId: 'https://127.0.0.1:9999' });
        expect(parseEnvKey('https://x|production')?.env).toBe('production');
        expect(parseEnvKey('https://x')).toBeNull();
        expect(parseEnvKey('https://x|unknown')).toBeNull();
    });
});

describe('trigger adapter', () => {
    it('skips alerts, bracket legs and legacy triggers without context', () => {
        expect(programsFromTriggers([
            trigger({ id: 'a', kind: 'alert' }),
            trigger({ id: 'b', bracketId: 'br' }),
            trigger({ id: 'c', account: undefined }),
            trigger({ id: 'd', suspended: 'legacy' }),
        ])).toEqual([]);
    });

    it('fires the same market order the web engine sends (fixed account, tradable code, octype)', () => {
        const [p] = programsFromTriggers([trigger({ octype: 'Cover' })]);
        const r = run([live(1), create(2, p!), tick(3, 101), tick(4, 100)]);
        expect(r.intents).toHaveLength(1);
        expect(r.intents[0]).toMatchObject({
            kind: 'place', action: 'Sell', qty: 2, orderCode: 'TXFJ6', price: null, env: 'simulation',
            account: { accountType: 'F', brokerId: 'F002000', accountId: '1234567' },
            order: { priceType: 'MKT', timeInForce: 'IOC', octype: 'Cover' },
        });
    });

    it('fires on touch exactly like the web condition (<= below, >= above)', () => {
        for (const [condition, price, last, fires] of [
            ['below', 100, 100, true], ['below', 100, 100.5, false], ['above', 100, 100, true], ['above', 100, 99.5, false],
        ] as const) {
            const [p] = programsFromTriggers([trigger({ condition, price })]);
            expect(run([live(1), create(2, p!), tick(3, last)]).intents.length > 0).toBe(fires);
        }
    });

    it('a manual OCO group is one program: the first fire cancels the sibling (processedGroups)', () => {
        const programs = programsFromTriggers([
            trigger({ id: 's', group: 'g1', condition: 'below', price: 95 }),
            trigger({ id: 't', group: 'g1', kind: 'take', condition: 'above', price: 110 }),
            trigger({ id: 'other', condition: 'below', price: 50 }),
        ]);
        expect(programs.map(p => [p.id, p.ocoLevels, p.levels.length])).toEqual([['grp:g1', true, 2], ['trg:other', false, 1]]);
        const r = run([live(1), create(2, programs[0]!), tick(3, 111), tick(4, 90)]);
        expect(r.intents.map(i => i.levelId)).toEqual(['t']);
        expect(r.state.programs[0]!.levels.find(l => l.id === 's')!.phase).toBe('done');
    });

    it('carries 待確認 and keep (awaitingRecross) state (#144)', () => {
        const [held] = programsFromTriggers([trigger({ pending: { price: 98, at: 5, reason: 'env' } })]);
        expect(held!.levels[0]).toMatchObject({ phase: 'needsConfirm', pending: { leg: 'entry', price: 98, reason: 'env' } });
        const [kept] = programsFromTriggers([trigger({ awaitingRecross: true })]);
        const r = run([live(1), create(2, kept!), tick(3, 99), tick(4, 101), tick(5, 100)]);
        expect(r.intents.map(i => i.key)).toEqual(['simulation/https%3A%2F%2F127.0.0.1%3A9999/trg:tg-1/tg-1/entry/0/0']);
    });
});

const plan = (over: Partial<BracketPlan> = {}): BracketPlan => ({
    id: 'bp1', env: ENV, account, market: 'futures', orderId: 'o-entry', seqno: '1', quoteCode: 'TXFR1', orderCode: 'TXFJ6',
    securityType: 'FUT', exchange: 'TAIFEX', action: 'Buy', quantity: 3, stopPrice: 95, takePrice: 110, group: 'grp',
    fills: {}, filled: 0, entryClosed: false, exit: null, issues: [], createdAt: 1, updatedAt: 1, ...over,
});

describe('bracket adapter', () => {
    it('maps plan phases', () => {
        expect(programFromBracket(plan())!.levels[0]!.phase).toBe('working');
        const protectedPlan = plan({ filled: 2, fills: { 'o-entry:1': 2 } });
        expect(bracketPhase(protectedPlan)).toBe('protected');
        expect(programFromBracket(protectedPlan)!.levels[0]).toMatchObject({ phase: 'holding', position: 2, entryFilled: 2 });
        const exiting = plan({ filled: 2, exit: { status: 'working', kind: 'stop', quantity: 2, filled: 0, fills: {}, orderId: 'x', at: 1 } });
        expect(programFromBracket(exiting)!.levels[0]).toMatchObject({ phase: 'exiting', unprotected: 0 });
        const unknown = plan({ filled: 1, exit: { status: 'unknown', kind: 'take', quantity: 1, filled: 0, fills: {}, at: 1 } });
        expect(programFromBracket(unknown)!.levels[0]!.phase).toBe('unknown');
        expect(programFromBracket(plan({ env: 'https://x' }))).toBeNull();
    });

    it('counts fills like bracket-core (dedupe by fill identity, event-only pairing) and protects the same quantity', () => {
        const fills: (FillEvidence & { seq: string | null; eventId: string })[] = [
            { orderId: 'o-entry', key: 'event:e1', quantity: 1, ts: 1700000000.5, seq: null, eventId: 'e1' },
            { orderId: 'o-entry', key: 'o-entry:s1', quantity: 1, ts: 1700000000.5, seq: 's1', eventId: 'e1b' },
            { orderId: 'o-entry', key: 'o-entry:s1', quantity: 1, ts: 1700000000.5, seq: 's1', eventId: 'e1c' },
            { orderId: 'o-entry', key: 'o-entry:s2', quantity: 1, ts: 1700000002, seq: 's2', eventId: 'e2' },
        ];
        let web = plan();
        for (const f of fills) web = applyEntryFill(web, f, 1);
        const program = programFromBracket(plan())!;
        const r = run([live(1), create(2, program), { type: 'reconcile', ts: 2, ...SRC,
            account: program.binding.account, complete: false,
            orders: [{ intentKey: program.levels[0]!.orders[0]!.key, orderId: 'o-entry', status: 'working', qty: 3, deals: [] }] },
        ...fills.map((f, i): ExecEvent => ({
            type: 'deal', ts: 3 + i, ...SRC, orderId: f.orderId, eventId: f.eventId, seq: f.seq,
            account: { brokerId: 'F002000', accountId: '1234567' }, code: 'TXFJ6', action: 'Buy', qty: f.quantity, price: 100, fillTs: f.ts,
        }))]);
        const level = r.state.programs[0]!.levels[0]!;
        expect(level.entryFilled).toBe(web.filled);
        expect(level.position).toBe(protectionQuantity(web));
        expect(Object.keys(level.orders[0]!.fills).sort()).toEqual(Object.keys(web.fills).sort());

        // the OCO fires for the protected quantity; a later entry fill is unprotected in both
        const fired = run([tick(10, 94)], r.state);
        expect(fired.intents).toHaveLength(1);
        expect(fired.intents[0]).toMatchObject({ action: 'Sell', qty: protectionQuantity(web), leg: 'stop', order: { octype: 'Cover' } });
        const late = run([{ type: 'deal', ts: 11, ...SRC, orderId: 'o-entry', eventId: 'e3', seq: 's3',
            account: { brokerId: 'F002000', accountId: '1234567' }, code: 'TXFJ6', action: 'Buy', qty: 1, price: 100,
            fillTs: 1700000003 }], fired.state);
        const webAfter = applyEntryFill({ ...web, exit: { status: 'sending', kind: 'stop', quantity: 2, filled: 0, fills: {}, at: 1 } },
            { orderId: 'o-entry', key: 'o-entry:s3', quantity: 1 }, 2);
        expect(late.state.programs[0]!.levels[0]!.unprotected).toBe(unprotectedQuantity(webAfter));
    });
});
