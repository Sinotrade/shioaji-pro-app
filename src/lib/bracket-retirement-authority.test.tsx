import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import type { Trade } from './types/order';
const h=vi.hoisted(()=>({env:'http://synthetic.invalid|simulation',mode:1,status:'live',
    accounts:[] as any[],rows:[] as Trade[],positions:[] as any[],reports:[] as any[],envListeners:[] as any[],statusListeners:[] as any[],
    place:[] as any[],cancel:[] as any[],contract:null as any,contractWait:null as Promise<any>|null,
    placeWait:null as Promise<void>|null,resultWait:null as Promise<void>|null,cancelWait:null as Promise<void>|null,listingWait:null as Promise<Trade[]>|null,failWrite:false,resultFailure:false}));
vi.mock('./runtime',()=>({getApiBase:()=> 'http://synthetic.invalid'}));
vi.mock('./protection-env',()=>({currentProtectionEnv:()=>h.env,envBase:(e:string)=>e.split('|')[0],reportEnvMatches:(e:string,b:string)=>e.startsWith(b+'|'),onProtectionEnvChange:(f:any)=>h.envListeners.push(f),refreshProtectionEnv:async()=>h.env,watchProtectionEnv:()=>{},protectionEnvLabel:()=> '模擬'}));
vi.mock('./server-info-store',()=>({getServerModeVersion:()=>h.mode,useServerInfo:()=>({simulation:true})}));
vi.mock('./account-store',()=>({getAccountState:()=>({accounts:h.accounts,selectedFutures:h.accounts.find(a=>a.account_type==='F'),selectedStock:h.accounts.find(a=>a.account_type==='S')}),accountFor:(t:string)=>h.accounts.find(a=>a.account_type===t)}));
vi.mock('./account-tradable',()=>({canTrade:(a:any)=>!!a}));
vi.mock('./stream',()=>({getStreamStatus:()=>h.status,subscribeStatusStore:(f:any)=>h.statusListeners.push(f),onAnyTick:()=>{},onOddLotTick:()=>{},onStreamEvent:()=>{}}));
vi.mock('./bracket-reports',()=>({onTrackedReport:(f:any)=>h.reports.push(f),recentReportsFor:()=>[]}));
vi.mock('./report-ledger',()=>({reportLedger:{onGap:()=>{}}}));
vi.mock('./trading-state',()=>({tradeCacheContinuous:()=>true,checkTradeCacheHealth:async()=>{},getTradingState:()=>({positions:h.positions,queries:{positions:{updatedAt:Date.now(),needsReconcile:false}}})}));
vi.mock('./contracts-cache',()=>({ensureContract:()=>h.contractWait??Promise.resolve(h.contract),getCachedContract:()=>h.contract}));
vi.mock('./quote-ownership',()=>({retainQuote:()=>()=>{}}));
vi.mock('./privacy',()=>({getPrivacyMode:()=>false,usePrivacyMode:()=>false,maskAccountId:(s:string)=>s}));
vi.mock('./execution/native',()=>{ const programs: never[]=[];return {nativeOwnsNew:()=>false,getNativeOwnerGeneration:()=>0,nativeExecutionSupported:()=>false,getNativePrograms:()=>programs,subscribeNative:()=>()=>{},getNativeLastPrices:()=>({}),useNativeHealth:()=>null,ensureNativeHost:()=>{throw Error('unsupported');},createNativeProgram:()=>{throw Error('unsupported');},refreshNative:()=>{},removeNativeProgram:()=>{throw Error('unsupported');},resolveNativePending:()=>{throw Error('unsupported');},sendNativeCommand:()=>{throw Error('unsupported');},confirmNativeEntry:()=>{},acknowledgeNativeUnknown:()=>{}};});
vi.mock('./trade',()=>({notify:()=>{},authorizeManualPendingOrder:async()=>{},placeQuickOrder:async(c:any,action:any,price:any,quantity:any,opts:any)=>{
    if(h.placeWait) await h.placeWait;
    opts.beforeSend?.();
    h.place.push({action,price,quantity,ocType:opts.ocType,lot:opts.orderLot});
    if(h.resultWait) await h.resultWait;
    if(h.resultFailure) throw Error('synthetic response lost after physical write');
    return {...h.rows[0],contract:c,order:{...h.rows[0]?.order,id:'EXIT',seqno:'EXIT-S',ordno:'EXIT-O',action,quantity},status:{status:'Submitted',deals:[]}};
}}));
vi.mock('./shioaji',()=>({fetchTrades:async()=>h.listingWait??h.rows,fetchTradeCacheHealth:async()=>({state:'Healthy',reasons:[]}),cancelVerifiedOrder:async(row:any,_account:any,opts:any)=>{
    if(h.cancelWait) await h.cancelWait;
    opts.beforeSend?.(); h.cancel.push(row.order.id); return {...row,status:{...row.status,status:'Cancelled',cancel_quantity:row.order.quantity-1}};
}}));
class MemoryStorage { rows=new Map<string,string>(); get length(){return this.rows.size;} key(i:number){return [...this.rows.keys()][i]??null;} getItem(k:string){return this.rows.get(k)??null;} setItem(k:string,v:string){if(h.failWrite&&k==='sj-pro-brackets')throw Error('disk unavailable');this.rows.set(k,v);} removeItem(k:string){this.rows.delete(k);} clear(){this.rows.clear();} }
const deferred=<T,>()=>{let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};};
const flush=async()=>{for(let i=0;i<20;i++) await Promise.resolve();};
let b:typeof import('./bracket');
let engine:typeof import('./trigger-engine');
let core:typeof import('./bracket-core');
let normalize:typeof import('./order-report')['normalizeOrderEvent'];
let context:typeof import('./protection-context');
let storage:MemoryStorage;
beforeEach(async()=>{
    vi.resetModules();vi.useFakeTimers();vi.stubGlobal('navigator',{});vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.stubGlobal('BroadcastChannel',undefined);vi.stubGlobal('location',{search:''});
    storage=new MemoryStorage();vi.stubGlobal('localStorage',storage);vi.stubGlobal('addEventListener',()=>{});
    h.env='http://synthetic.invalid|simulation';h.mode=1;h.status='live';h.rows=[];h.accounts=[];h.positions=[];h.reports=[];h.envListeners=[];h.statusListeners=[];h.place=[];h.cancel=[];h.contractWait=null;h.placeWait=null;h.resultWait=null;h.cancelWait=null;h.listingWait=null;h.failWrite=false;h.resultFailure=false;
    b=await import('./bracket');
    engine=await import('./trigger-engine');
    core=await import('./bracket-core');
    normalize=(await import('./order-report')).normalizeOrderEvent;
    context=await import('./protection-context');
    b.startBracketRuntime();engine.startTriggerEngine();await flush();
});
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();vi.unstubAllGlobals();});
async function seed(type:'FUT'|'OPT'|'Common'|'IntradayOdd',filled=1){
    const stock=type==='Common'||type==='IntradayOdd'; const lot=stock?type:'Common';
    const account={account_type:stock?'S' as const:'F' as const,broker_id:'SIM-B',account_id:'SIM-A',signed:true};h.accounts=[account];
    h.contract={security_type:stock?'STK':type,exchange:stock?'TSE':'TAIFEX',code:stock?'2330':type==='OPT'?'TXO202610C20000':'TXFJ6',target_code:null,name:'Synthetic',limit_up:120,limit_down:80};
    const trade:any={account,contract:h.contract,order:{account,id:'ENTRY',seqno:'S1',ordno:'O1',action:'Buy',quantity:3,order_lot:lot,price:100,order_type:'ROD',price_type:'LMT',oc_type:'New',order_cond:'Cash'},status:{id:'ENTRY',status:filled?'PartFilled':'Submitted',order_quantity:3,cancel_quantity:0,deal_quantity:filled,deals:filled?[{seq:'D1',quantity:filled,price:100,ts:Date.now()/1000}]:[]}};h.rows=[trade];h.positions=[{account,code:h.contract.code,direction:'Buy',quantity:stock&&lot==='Common'?filled*1000:filled,cond:'Cash'}];
    const spec={env:h.env,account,orderId:'ENTRY',seqno:'S1',ordno:'O1',quoteCode:h.contract.code,orderCode:h.contract.code,securityType:h.contract.security_type,exchange:h.contract.exchange,action:'Buy' as const,quantity:3,orderLot:lot as any,stopPrice:90,takePrice:110};
    const p=await b.registerBracket(spec);await flush(); expect(b.getBrackets()[0]?.filled).toBe(filled);engine.evaluateTick(h.contract.code,100,lot==='IntradayOdd');return p;
}
const current=()=>b.getBrackets()[0]!;
const persisted=()=>JSON.parse(storage.getItem('sj-pro-brackets')!)[0];
function ownDeal(seq='S1',event='D2'){
    const stock=h.contract.security_type==='STK';const variant=stock?'StockDeal':'FuturesDeal';const body={...h.accounts[0],account:h.accounts[0],exchange_seq:event,trade_id:'ENTRY',seqno:seq,ordno:'O1',code:h.contract.code,full_code:h.contract.code,security_type:h.contract.security_type,exchange:h.contract.exchange,action:'Buy',quantity:1,price:100,order_lot:h.rows[0]?.order.order_lot,ts:Date.now()/1000,event_id:event};
    const report=normalize({state:variant,data:{[variant]:body}})!; for(const f of h.reports)f(report,{context:context.currentReportContext(),untrackable:false},'http://synthetic.invalid');
}
async function render(){const {BracketStatusList}=await import('../components/bracket-status');let tree!:ReactTestRenderer;await act(async()=>{tree=create(<BracketStatusList code={h.contract.code}/>);});return tree;}
describe('r41 current window authority and retained retirement risk',()=>{
    for(const type of ['FUT','OPT','Common','IntradayOdd'] as const){
        it(`${type}: Close blocks queued ensureContract Place; own latefill cannot authorize Cancel`,async()=>{
            await seed(type);const wait=deferred<any>();h.contractWait=wait.promise;engine.evaluateTick(h.contract.code,111,type==='IntradayOdd');expect(engine.getExits()[0]?.status).toBe('sending');
            await b.dismissBracket(current().id);expect(persisted().observationOnly).toBe(true);wait.resolve(h.contract);await flush();expect(h.place).toHaveLength(0);expect(engine.getExits()[0]?.status).toBe('not-sent');
            ownDeal('WRONG');expect(current().filled).toBe(1);ownDeal();ownDeal();expect(current().filled).toBe(2);expect(current().observationOnly).toBe(true);expect(core.unprotectedQuantity(current())).toBe(2);
            await expect(b.cancelRemainingEntry(current())).rejects.toThrow();expect(h.cancel).toHaveLength(0);
        });
        it(`${type}: current active controls send once and cancel remaining once`,async()=>{await seed(type);engine.evaluateTick(h.contract.code,111,type==='IntradayOdd');await flush();expect(h.place).toHaveLength(1);expect(h.place[0].quantity).toBe(1);expect(h.place[0].action).toBe('Sell');await b.cancelRemainingEntry(current());expect(h.cancel).toHaveLength(1);});
        it(`${type}: successful two-click Close retains currently known exposure in persistent and actual component`,async()=>{
            await seed(type);const tree=await render();const button=()=>tree.root.findAllByType('button').find(x=>String(x.props.children).includes('移除'))!;
            await act(async()=>{button().props.onClick();});expect(current().observationOnly).not.toBe(true);await act(async()=>{button().props.onClick();await flush();});
            expect(persisted().observationOnly).toBe(true);expect(core.unprotectedQuantity(current())).toBe(1);expect(persisted().dismissed).toBe(false);expect(tree.toJSON()).not.toBeNull();
            expect(tree.root.findAllByType('div').some(x=>x.children.filter(c=>typeof c==='string').join('').includes('可能未保護 1'))).toBe(true);expect(engine.getExits()).toHaveLength(0);expect(h.place).toHaveLength(0);await act(async()=>tree.unmount());
        });
    }
    it('actual final Place callback rechecks Close after adapter wait',async()=>{await seed('FUT');const wait=deferred<void>();h.placeWait=wait.promise;engine.evaluateTick(h.contract.code,111);await flush();await b.dismissBracket(current().id);wait.resolve();await flush();expect(h.place).toHaveLength(0);});
    for(const stage of ['listing','final'] as const)it(`Cancel ${stage} wait rechecks successful Close using current immutable plan`,async()=>{
        await seed('FUT');engine.evaluateTick(h.contract.code,111);await flush();const listing=deferred<Trade[]>(),final=deferred<void>();if(stage==='listing')h.listingWait=listing.promise;else h.cancelWait=final.promise;
        const pending=b.cancelRemainingEntry(current());const outcome=pending.catch(e=>e);await flush();await b.dismissBracket(current().id);listing.resolve(h.rows);final.resolve();await outcome;expect(h.cancel).toHaveLength(0);expect(current().observationOnly).toBe(true);
    });
    it('failed retirement persistence does not revoke an active queued protective exit',async()=>{await seed('FUT');const wait=deferred<any>();h.contractWait=wait.promise;engine.evaluateTick(h.contract.code,111);h.failWrite=true;await expect(b.dismissBracket(current().id)).rejects.toThrow('disk unavailable');h.failWrite=false;wait.resolve(h.contract);await flush();expect(h.place).toHaveLength(1);expect(current().observationOnly).not.toBe(true);});
    it('same Info refresh retains current guard; away/back rejects queued guard',async()=>{await seed('FUT');const wait=deferred<void>();h.placeWait=wait.promise;engine.evaluateTick(h.contract.code,111);await flush();for(const f of h.envListeners)f();wait.resolve();await flush();expect(h.place).toHaveLength(1);});
    it('away/back before physical send never revives captured report context',async()=>{await seed('FUT');const wait=deferred<void>();h.placeWait=wait.promise;engine.evaluateTick(h.contract.code,111);await flush();h.mode++;for(const f of h.envListeners)f();h.mode++;for(const f of h.envListeners)f();wait.resolve();await flush();expect(h.place).toHaveLength(0);});
    it('zero known exposure safely closes, late own fill restores observation-only UI and no arms',async()=>{await seed('FUT',0);await b.dismissBracket(current().id);expect(persisted().dismissed).toBe(true);let tree=await render();expect(tree.toJSON()).toBeNull();await act(async()=>{ownDeal();await flush();});expect(current().observationOnly).toBe(true);expect(current().dismissed).toBe(false);expect(tree.toJSON()).not.toBeNull();engine.evaluateTick(h.contract.code,111);await flush();expect(h.place).toHaveLength(0);await act(async()=>tree.unmount());});
    it('stale UI commands cannot use an active captured copy after successful Close',async()=>{await seed('FUT');engine.evaluateTick(h.contract.code,111);await flush();const stale={...current(),account:{...current().account}};await b.dismissBracket(current().id);await expect(b.cancelRemainingEntry(stale)).rejects.toThrow();expect(h.cancel).toHaveLength(0);const tree=await render();expect(tree.root.findAllByType('button').some(x=>String(x.props.children).includes('刪除剩餘'))).toBe(false);await act(async()=>tree.unmount());});
    it('Close after physical Place preserves the actual sent outcome without a second send',async()=>{await seed('FUT');const held=deferred<void>();h.resultWait=held.promise;engine.evaluateTick(h.contract.code,111);await flush();expect(h.place).toHaveLength(1);await b.dismissBracket(current().id);held.resolve();await flush();expect(h.place).toHaveLength(1);expect(current().exit?.status).toBe('working');expect(current().observationOnly).toBe(true);engine.evaluateTick(h.contract.code,89);await flush();expect(h.place).toHaveLength(1);});
    it('legacy dismissed tombstone with known risk stays visible in the actual component',async()=>{await seed('Common');await b.dismissBracket(current().id);const legacy={...current(),dismissed:true};storage.setItem('sj-pro-brackets',JSON.stringify([legacy]));vi.resetModules();h.reports=[];const fresh=await import('./bracket');const freshEngine=await import('./trigger-engine');fresh.startBracketRuntime();freshEngine.startTriggerEngine();await flush();const tree=await render();expect(tree.toJSON()).not.toBeNull();expect(fresh.getBrackets()[0]?.observationOnly).toBe(true);expect(h.place).toHaveLength(0);await act(async()=>tree.unmount());});
    it('a fresh reader preserves known retired risk without restoring trigger authority',async()=>{await seed('Common');await b.dismissBracket(current().id);const saved=storage.getItem('sj-pro-brackets')!;vi.resetModules();h.reports=[];const fresh=await import('./bracket');const freshEngine=await import('./trigger-engine');fresh.startBracketRuntime();freshEngine.startTriggerEngine();await flush();expect(JSON.parse(saved)[0].dismissed).toBe(false);expect(fresh.getBrackets()[0]?.observationOnly).toBe(true);expect(core.unprotectedQuantity(fresh.getBrackets()[0]!)).toBe(1);expect(freshEngine.getExits()).toHaveLength(0);expect(h.place).toHaveLength(0);});
});

// r42 uses the actual exit producer and component. Entry is strictly terminal
// before the exit starts, so neither pending entry nor issues masks visibility.
async function terminalEntryExit(type:'FUT'|'OPT'|'Common'|'IntradayOdd',sending=false){
    await seed(type);h.rows[0]!.status.status='Cancelled';h.rows[0]!.status.cancel_quantity=2;
    await b.reconcileBracket(current().id);expect(current().entryClosed).toBe(true);expect(current().issues).toEqual([]);
    const wait=deferred<void>();if(sending)h.resultWait=wait.promise;
    engine.evaluateTick(h.contract.code,111,type==='IntradayOdd');await flush();
    expect(h.place).toHaveLength(1);expect(current().exit?.status).toBe(sending?'sending':'working');
    expect(core.needsAttention(current())).toBe(false);return wait;
}
describe('r42 retained active exit observation',()=>{
    for(const type of ['FUT','OPT','Common','IntradayOdd'] as const)for(const status of ['sending','working'] as const){
        it(`${type} ${status}: successful Close keeps the already physical exit visible and read-only`,async()=>{
            const wait=await terminalEntryExit(type,status==='sending');const tree=await render();expect(tree.toJSON()).not.toBeNull();
            const button=()=>tree.root.findAllByType('button').find(x=>String(x.props.children).includes('移除'))!;
            await act(async()=>{button().props.onClick();});await act(async()=>{button().props.onClick();await flush();});
            expect(current().observationOnly).toBe(true);expect(core.needsAttention(current())).toBe(false);
            expect(persisted().dismissed).toBe(false);expect(tree.toJSON()).not.toBeNull();
            expect(tree.root.findAllByType('button').some(x=>String(x.props.children).includes('刪除剩餘'))).toBe(false);
            await expect(b.cancelRemainingEntry(current())).rejects.toThrow();expect(h.cancel).toHaveLength(0);
            await act(async()=>{wait.resolve();await flush();});expect(current().exit?.status).toBe('working');expect(tree.toJSON()).not.toBeNull();
            engine.evaluateTick(h.contract.code,89,type==='IntradayOdd');await flush();expect(h.place).toHaveLength(1);
            await act(async()=>tree.unmount());
        });
    }
    it('an already physical exit with lost response remains durable unknown and visible',async()=>{
        const wait=await terminalEntryExit('FUT',true);await b.dismissBracket(current().id);h.resultFailure=true;wait.resolve();await flush();
        expect(current().exit?.status).toBe('unknown');expect(persisted().exit.status).toBe('unknown');expect(persisted().dismissed).toBe(false);
        const tree=await render();expect(tree.toJSON()).not.toBeNull();expect(h.place).toHaveLength(1);expect(h.cancel).toHaveLength(0);await act(async()=>tree.unmount());
    });
    it('terminal full exit evidence permits explicit zero-risk Close without restoring authority',async()=>{
        await terminalEntryExit('FUT');await b.dismissBracket(current().id);
        const row=h.rows[0]!;engine.applyExitTrade({...row,order:{...row.order,id:'EXIT',seqno:'EXIT-S',ordno:'EXIT-O',action:'Sell',quantity:1},status:{...row.status,status:'Filled',order_quantity:1,cancel_quantity:0,deal_quantity:1,deals:[{seq:'XD1',quantity:1,price:111,ts:Date.now()/1000}]}});
        expect(current().exit?.status).toBe('filled');expect(core.needsAttention(current())).toBe(false);
        await b.dismissBracket(current().id);expect(persisted().dismissed).toBe(true);const tree=await render();expect(tree.toJSON()).toBeNull();expect(h.place).toHaveLength(1);await act(async()=>tree.unmount());
    });
    it('legacy dismissed observation ledger with a working exit remains visible by the same contract',async()=>{
        await terminalEntryExit('FUT');await b.dismissBracket(current().id);const legacy={...current(),dismissed:true};
        vi.spyOn(b,'useBrackets').mockReturnValue([legacy]);const tree=await render();expect(tree.toJSON()).not.toBeNull();expect(h.place).toHaveLength(1);await act(async()=>tree.unmount());
    });
});
