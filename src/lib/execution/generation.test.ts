import { expect, it } from 'vitest';
import { initialState, step } from './core';
import type { EngineState, ExecEvent } from './model';
import scenario from './scenarios/protective-exit-not-sent-keeps-position.json';
it('r33 legacy stopped snapshot exposes failed protective exit risk without resending', () => {
    let state = initialState();
    for (const item of scenario.steps.slice(0, 10)) state = step(state, item.event as ExecEvent).state;
    const old: EngineState = JSON.parse(JSON.stringify(state));
    const p = old.programs[0]!;p.status = 'stopped';p.levels[0]!.unprotected = 0;
    p.levels[0]!.orders.forEach(slot => { delete slot.submitVersion; });
    const result = step(old, { type: 'restore', ts: 1011 });
    expect(result.intents).toEqual([]);
    expect(result.state.programs[0]).toMatchObject({ status: 'stopping', levels: [{ position: 1, unprotected: 1 }] });
    expect(result.state.programs[0]!.levels[0]!.orders.every(slot => slot.submitVersion === undefined)).toBe(true);
});
