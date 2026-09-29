import {describe, it, expect} from 'vitest';
import {displayDayRange} from './display-day-range';
import type {Snapshot, SseTick} from './types/market';
const snap = {code:'6182', datetime:'2026-09-29 09:05:00', high:120.5,low:117,close:119} as Snapshot;
const tick = {code:'6182',date:'2026-09-29',time:'12:07:00',high:'124.5',low:'115.5',close:'122'} as SseTick;
describe('chart header day range',()=>{
 it('replaces the opening snapshot with live exchange high/low',()=>{
   expect(displayDayRange('6182',null,snap,tick)).toMatchObject({high:124.5,low:115.5,source:'即時'});
 });
 it('does not overwrite a newer snapshot with an old tick',()=>{
   expect(displayDayRange('6182',null,{...snap,datetime:'2026-09-29 12:08:00'},tick)?.source).toBe('快照');
 });
 it('does not combine previous-day extremes into a new day',()=>{
   expect(displayDayRange('6182',null,{...snap,datetime:'2026-09-28 13:30:00',high:200,low:80},tick)).toMatchObject({high:124.5,low:115.5});
 });
 it('ignores another symbol and accepts a futures alias target',()=>{
   expect(displayDayRange('2330',null,snap,tick)).toBeNull();
   expect(displayDayRange('TXFR1','6182',undefined,tick)?.high).toBe(124.5);
 });
 it('does not display invalid or inconsistent fresh ranges',()=>{
   for(const high of ['NaN','0','120'])expect(displayDayRange('6182',null,snap,{...tick,high})).toBeNull();
 });
 it('ignores simulated ticks and retains timestamped snapshot fallback',()=>{
   expect(displayDayRange('6182',null,snap,{...tick,simtrade:true})?.source).toBe('快照');
   expect(displayDayRange('6182',null,undefined,tick)?.source).toBe('即時');
 });
});
