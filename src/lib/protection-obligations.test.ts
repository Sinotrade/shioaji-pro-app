import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const m=vi.hoisted(()=>({desktop:false,invoke:vi.fn(),notify:vi.fn()}));
vi.mock('./execution/native', () => ({ nativeExecutionSupported: () => m.desktop }));
vi.mock('@tauri-apps/api/core',()=>({invoke:m.invoke}));
vi.mock('./trade',()=>({notify:m.notify}));
class MemoryStorage implements Storage {
    data = new Map<string,string>(); get length(){ return this.data.size; }
    key(i:number){ return [...this.data.keys()][i] ?? null; }
    clear(){ this.data.clear(); } removeItem(k:string){ this.data.delete(k); }
    getItem(k:string){ return this.data.get(k) ?? null; }
    setItem(k:string,v:string){ this.data.set(k,v); }
}
const request = { env: 'http://sim.invalid|simulation', account: { account_type:'F' as const, broker_id:'fixture',account_id:'F1'},
    quoteCode:'TXFR1',orderCode:'TXFJ6',securityType:'FUT' as const,exchange:'TAIFEX',action:'Buy' as const,quantity:1,stopPrice:90,takePrice:110,
    entryOrder:{action:'Buy',quantity:1,price:0,price_type:'MKT',order_type:'IOC',octype:'New'} };
const admission = {owner:'window' as const,env:request.env,orderLot:'Common' as const,contextGeneration:1,ownerGeneration:1,hostId:'fixture-host'};
let storage:MemoryStorage;
beforeEach(()=>{ m.desktop=false;vi.clearAllMocks();vi.resetModules();storage=new MemoryStorage();vi.stubGlobal('localStorage',storage);vi.stubGlobal('window',{addEventListener:vi.fn()}); });
afterEach(()=>{ vi.unstubAllGlobals();vi.useRealTimers(); });
it('r40 actual API transport awaits exact persisted preparation before any physical write',async()=>{
    const p=await import('./protection-obligations'); const receipt=await p.prepareProtectionObligation(request,admission);
    const physical=vi.fn(async()=>new Response('{"order":{"id":"entry-1","seqno":"S1"}}'));
    vi.stubGlobal('fetch',physical); const {apiPost}=await import('./api');
    await apiPost('/api/v1/order/place_order',{quantity:1},{beforeDispatch:()=>p.verifyProtectionReceipt(receipt)});
    expect(physical).toHaveBeenCalledTimes(1);
    vi.resetModules();const cold=await import('./protection-obligations');expect(cold.getProtectionObligations()).toHaveLength(1);
    expect(cold.getProtectionObligations()[0]!.obligation.request).toEqual(request);
});
it.each(['denied','missing','mismatch'])('r40 first receipt %s fails before actual physical API dispatch',async fault=>{
    const physical=vi.fn();vi.stubGlobal('fetch',physical);
    if(fault==='denied')storage.setItem=()=>{throw new Error('fixture storage denied');};
    if(fault==='missing')storage.setItem=()=>undefined;
    if(fault==='mismatch')storage.setItem=(k,v)=>storage.data.set(k,v.replace('TXFJ6','foreign'));
    const p=await import('./protection-obligations');
    await expect(p.prepareProtectionObligation(request,admission)).rejects.toThrow();expect(physical).not.toHaveBeenCalled();
});
it('r40 independent writers and fresh reader preserve distinct immutable operations, including identical orders',async()=>{
    const a=await import('./protection-obligations');const ra=await a.prepareProtectionObligation(request,admission);
    vi.resetModules();const b=await import('./protection-obligations');const rb=await b.prepareProtectionObligation(request,admission);
    expect(ra.record.id).not.toBe(rb.record.id);
    await a.verifyProtectionReceipt(ra);await b.verifyProtectionReceipt(rb);
    vi.resetModules();const cold=await import('./protection-obligations');expect(cold.getProtectionObligations()).toHaveLength(2);
    await cold.acknowledgeProtectionObligation(ra.record.id);
    vi.resetModules();const last=await import('./protection-obligations');expect(last.getProtectionObligations().filter(x=>!x.acknowledged).map(x=>x.id)).toEqual([rb.record.id]);
});
it.each(['acknowledged','completed','missing','immutable conflict'])('r40 receipt %s while async fence is held prevents actual transport write',async fault=>{
    const p=await import('./protection-obligations');const receipt=await p.prepareProtectionObligation(request,admission);
    const {apiPost}=await import('./api');const physical=vi.fn();vi.stubGlobal('fetch',physical);
    let release!:()=>void;const wait=new Promise<void>(r=>{release=r;});
    const sending=apiPost('/api/v1/order/place_order',{}, {beforeDispatch:async()=>{await wait;await p.verifyProtectionReceipt(receipt);}});
    const failure=expect(sending).rejects.toThrow();
    if(fault==='acknowledged')await p.acknowledgeProtectionObligation(receipt.record.id);
    else if(fault==='completed')await p.completeProtectionObligation(receipt,{...request,orderId:'entry-1',seqno:'S1'},'plan-1');
    else if(fault==='missing')storage.clear();
    else {const key=storage.key(0)!;storage.setItem(key,storage.getItem(key)!.replace('TXFJ6','foreign'));}
    release();await failure;expect(physical).not.toHaveBeenCalled();
});
it('r40 actual timeout during persistent receipt wait never emits a late request',async()=>{
    vi.useFakeTimers();const p=await import('./protection-obligations');const receipt=await p.prepareProtectionObligation(request,admission);
    const {apiPost}=await import('./api');const physical=vi.fn();vi.stubGlobal('fetch',physical);
    let release!:()=>void;const wait=new Promise<void>(r=>{release=r;});
    const sending=apiPost('/api/v1/order/place_order',{}, {beforeDispatch:async()=>{await wait;await p.verifyProtectionReceipt(receipt);}});
    const failure=expect(sending).rejects.toMatchObject({requestTimedOut:true});await vi.advanceTimersByTimeAsync(3000);await failure;
    release();await vi.advanceTimersByTimeAsync(1);expect(physical).not.toHaveBeenCalled();expect(p.getProtectionObligations()).toHaveLength(1);
});
it('r40 physical entry failure/unknown keeps original durable obligation for a fresh reader without replay',async()=>{
    const p=await import('./protection-obligations');const receipt=await p.prepareProtectionObligation(request,admission);
    const {apiPost}=await import('./api');const physical=vi.fn(async()=>{throw new Error('fixture lost reply after write');});vi.stubGlobal('fetch',physical);
    await expect(apiPost('/api/v1/order/place_order',{}, {beforeDispatch:()=>p.verifyProtectionReceipt(receipt)})).rejects.toThrow();
    expect(physical).toHaveBeenCalledTimes(1);vi.resetModules();const cold=await import('./protection-obligations');expect(cold.getProtectionObligations()).toHaveLength(1);expect(physical).toHaveBeenCalledTimes(1);
});
it('r40 completion write failure preserves the pre-entry obligation across cold load',async()=>{
    const p=await import('./protection-obligations');const receipt=await p.prepareProtectionObligation(request,admission);
    storage.setItem=()=>{throw new Error('fixture completion denied');};
    await expect(p.completeProtectionObligation(receipt,{...request,orderId:'entry-1',seqno:'S1'},'plan-1')).rejects.toThrow();
    vi.resetModules();const cold=await import('./protection-obligations');expect(cold.getProtectionObligations()[0]!.completed).toBeUndefined();
    expect(cold.getProtectionObligations()[0]!.obligation).toEqual(receipt.record.obligation);
});
it('r40 desktop preparation is host-receipt gated independently of native OFF, with no program/enable commands',async()=>{
    m.desktop=true;
    m.invoke.mockImplementation(async(command:string,args:Record<string,unknown>)=>{
        if(command==='execution_protection_records')return [];
        if(command==='execution_protection_prepare')return {id:(args.obligation as {id:string}).id,obligation:args.obligation,receipt:'fixture-durable-host-receipt'};
        if(command==='execution_protection_check')return true;
        throw new Error('unexpected command '+command);
    });
    const p=await import('./protection-obligations');const receipt=await p.prepareProtectionObligation(request,admission);await p.verifyProtectionReceipt(receipt);
    expect(m.invoke.mock.calls.filter(([name])=>name==='execution_protection_prepare')).toHaveLength(1);
    expect(m.invoke.mock.calls.filter(([name])=>name==='execution_protection_check')).toHaveLength(1);
    expect(m.invoke.mock.calls.every(([name])=>String(name).startsWith('execution_protection_'))).toBe(true);
});
it.each(['unavailable','mismatch'])('r40 desktop %s preparation ACK cannot admit a physical mutation',async fault=>{
    m.desktop=true;m.invoke.mockImplementation(async(command:string,args:Record<string,unknown>)=>{
        if(command==='execution_protection_records')return [];
        if(fault==='unavailable')throw new Error('fixture host storage failed');
        return {id:(args.obligation as {id:string}).id,obligation:{...(args.obligation as object),ownerGeneration:99},receipt:'wrong'};
    });
    const p=await import('./protection-obligations');const physical=vi.fn();vi.stubGlobal('fetch',physical);
    await expect(p.prepareProtectionObligation(request,admission)).rejects.toThrow();expect(physical).not.toHaveBeenCalled();
    vi.resetModules();const cold=await import('./protection-obligations');expect(cold.getProtectionObligations()).toHaveLength(1);
});
it('r40 host read failure visibly warns rather than silently claiming a cold empty ledger',async()=>{
    m.desktop=true;m.invoke.mockRejectedValue(new Error('fixture unreadable host ledger'));
    const p=await import('./protection-obligations');await expect(p.refreshProtectionObligations()).rejects.toThrow();
    expect(m.notify).toHaveBeenCalledWith(expect.objectContaining({kind:'err',title:'保護義務紀錄無法確認'}));
});
it.each(['quantity','scope','stable'])('r40 completion %s mismatch cannot clear original preparation',async field=>{
    const p=await import('./protection-obligations');const receipt=await p.prepareProtectionObligation(request,admission);
    const completed={...request,orderId:'entry-1',seqno:'S1'};
    if(field==='quantity')completed.quantity=2;
    if(field==='scope')completed.account={...request.account,account_id:'foreign'};
    if(field==='stable')completed.seqno='';
    await expect(p.completeProtectionObligation(receipt,completed,'plan-1')).rejects.toThrow();
    vi.resetModules();const cold=await import('./protection-obligations');expect(cold.getProtectionObligations()[0]!.completed).toBeUndefined();
});
it.each(['completion','ack'])('r40 silently dropped %s storage write cannot return an ACK',async outcome=>{
    const p=await import('./protection-obligations');const receipt=await p.prepareProtectionObligation(request,admission);
    storage.setItem=()=>undefined;
    const ack=outcome==='completion' ? p.completeProtectionObligation(receipt,{...request,orderId:'entry-1',seqno:'S1'},'plan-1') : p.acknowledgeProtectionObligation(receipt.record.id);
    await expect(ack).rejects.toThrow();
    vi.resetModules();const cold=await import('./protection-obligations');expect(cold.getProtectionObligations()[0]!.completed).toBeUndefined();expect(cold.getProtectionObligations()[0]!.acknowledged).not.toBe(true);
});
