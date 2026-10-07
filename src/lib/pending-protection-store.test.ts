import { describe, expect, it } from 'vitest';
import { pendingProtectionStore } from './pending-protection-store';
function fixture() {
    const data = new Map<string,string>();
    const s = { clear: () => data.clear(), getItem: (k:string) => data.get(k) ?? null, setItem: (k:string,v:string) => data.set(k,v),
        removeItem: (k:string) => data.delete(k), key: (i:number) => [...data.keys()][i] ?? null,
        get length() { return data.size; } } as Storage;
    const valid = (v:unknown): v is {id:string; identity:string; detail:string} => !!v && typeof v === 'object' && typeof (v as {id?:unknown}).id === 'string';
    return { data, s, writer: () => pendingProtectionStore('ledger',valid,()=>s) };
}
describe('durable registration operations across independent writers',()=>{
    it('interleaved writers, completion, reload and identity aliases retain every unresolved operation',()=>{
        const {s,writer}=fixture(); const a=writer(),b=writer();
        const original=s.setItem.bind(s); let nested=true;
        s.setItem=(key,value)=>{if(nested){nested=false;b.write({id:'op-B',identity:'S1/new-id',detail:'unknown'});}original(key,value);};
        a.write({id:'op-A',identity:'S1/old-id',detail:'unknown'});
        expect(writer().rows().map(r=>r.id).sort()).toEqual(['op-A','op-B']);
        a.complete('op-A'); expect(writer().rows().map(r=>r.id)).toEqual(['op-B']);
        b.write({id:'op-B',identity:'S1/new-id',detail:'late error'});
        expect(writer().rows()).toEqual([{id:'op-B',identity:'S1/new-id',detail:'late error'}]);
    });
    it('new registration never mutates/deletes the legacy array; only its explicit own acknowledgment hides a legacy entry',()=>{
        const {data,writer}=fixture(); const legacy=[{id:'legacy-A',identity:'S1',detail:'unknown'},{id:'legacy-B',identity:'S2',detail:'unknown'}];
        const raw=JSON.stringify(legacy);data.set('ledger',raw);
        const a=writer(),b=writer();a.write({id:'op-A',identity:'S1',detail:'registering'});a.complete('op-A');
        expect(b.rows()).toEqual(legacy);expect(data.get('ledger')).toBe(raw);
        a.acknowledge('legacy-A');expect(b.rows()).toEqual([legacy[1]]);expect(data.get('ledger')).toBe(raw);
        // Changed legacy evidence is a new risk; an old ACK cannot hide it.
        legacy[0]!.detail='changed';data.set('ledger',JSON.stringify(legacy));expect(writer().rows()).toHaveLength(2);
    });
    it('writer failure cannot claim durable success or erase an existing record',()=>{
        const {s,writer}=fixture();writer().write({id:'B',identity:'S2',detail:'unknown'});
        s.setItem=()=>{throw new Error('quota');};expect(()=>writer().write({id:'A',identity:'S1',detail:'unknown'})).toThrow('quota');
        s.removeItem=()=>{throw new Error('quota');};expect(()=>writer().complete('B')).toThrow('quota');expect(writer().rows()).toHaveLength(1);
    });
});
