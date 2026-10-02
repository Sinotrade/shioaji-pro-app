import { beforeEach, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({status:'live', callbacks:[] as (()=>void)[], creates:0, base:'http://fixture.invalid'}));
vi.mock('./runtime',()=>({getApiBase:()=> m.base}));
vi.mock('./stream',()=>({getStreamStatus:()=>m.status,subscribeStatusStore:(cb:()=>void)=>{m.callbacks.push(cb);return ()=>{};},onOrderEvent:()=>()=>{},onAnyTick:()=>()=>{},onOddLotTick:()=>()=>{},onStreamEvent:()=>()=>{}}));
vi.mock('./account-store',()=>({getAccountState:()=>({accounts:[],selectedFutures:null,selectedStock:null})}));
vi.mock('./trade',()=>({notify:vi.fn(),placeQuickOrder:vi.fn()}));
vi.mock('./contracts-cache',()=>({ensureContract:vi.fn(),getCachedContract:()=>undefined}));
vi.mock('./quote-ownership',()=>({retainQuote:()=>()=>{}}));
vi.mock('./trading-state',()=>({tradeCacheContinuous:()=>true,checkTradeCacheHealth:vi.fn(),getTradingState:()=>({positions:[],queries:{positions:{updatedAt:null,needsReconcile:false,error:null}}})}));
vi.mock('./shioaji',()=>({fetchInfo:async()=>{},fetchTrades:async()=>[],fetchTradeCacheHealth:async()=>({state:'Healthy',reasons:[]}),cancelOrder:vi.fn()}));
vi.mock('./boot',()=>({subscribeTradeReports:vi.fn()}));
const info = {simulation:true,version:'fixture-1.7.7',instance_id:'fixture-session-1'} as any;
const spec = {env:'http://fixture.invalid|simulation',account:{account_type:'F' as const,broker_id:'fixture-broker',account_id:'fixture-account'},orderId:'fixture-entry',seqno:'fixture-seq',quoteCode:'TXFR1',orderCode:'TXFJ6',securityType:'FUT' as const,exchange:'TAIFEX',action:'Buy' as const,quantity:1,stopPrice:95,takePrice:110};
beforeEach(()=>{
 vi.resetModules();m.callbacks=[];m.creates=0;m.status='live';m.base='http://fixture.invalid';
 const store=new Map<string,string>();
 vi.stubGlobal('localStorage',{getItem:(k:string)=>store.get(k)??null,setItem:(k:string,v:string)=>store.set(k,v)});
 vi.stubGlobal('BroadcastChannel',undefined);vi.stubGlobal('location',{search:''});vi.stubGlobal('window',{addEventListener:vi.fn(),removeEventListener:vi.fn()});vi.stubGlobal('navigator',{});
});
async function boot(nativeOwner:boolean){
 const server=await import('./server-info-store');server.observeServerInfo(server.beginServerInfoRequest(),info);
 const native=await import('./execution/native');
 native.__setNativeInvokeForTest(async <T>(cmd:string,args?:any)=>{
  if(cmd==='execution_status'||cmd==='execution_set_enabled')return {enabled:true,state:'live',env:'simulation',serverId:'http://fixture.invalid',revision:1,programs:0} as T;
  if(cmd==='execution_programs')return {revision:1,programs:[],lastPrices:{}} as T;
  if(cmd==='execution_command'){m.creates++;return {accepted:true,notices:[],revision:2} as T;}
  throw new Error(cmd);
 },{enabled:nativeOwner,desktop:true});await native.refreshNative();
 const engine=await import('./trigger-engine');const bracket=await import('./bracket');engine.startTriggerEngine();bracket.startBracketRuntime();
 for(let i=0;i<16;i++)await Promise.resolve();
 return {server,native,bracket};
}
it.each([false,true])('same-mode successful info refresh after entry does not discard owner=%s protection',async(owner)=>{
 const {server,bracket}=await boot(owner);const admission=await bracket.ensureBracketHost();
 // A normal read-only info request settles while the entry HTTP response is pending.
 server.observeServerInfo(server.beginServerInfoRequest(),{...info});
 let error:unknown;try{await bracket.registerBracket(spec,admission);}catch(e){error=e;}
 const rows=bracket.getDisplayBrackets();
 expect(error).toBeUndefined();expect(rows.some(p=>p.registrationPending)).toBe(false);
});
it.each([false,true])('unchanged context admits protection for owner=%s',async(owner)=>{
 const {bracket}=await boot(owner);const admission=await bracket.ensureBracketHost();
 const result=await bracket.registerBracket(spec,admission);expect(result.orderId).toBe(spec.orderId);
 expect(bracket.getDisplayBrackets().some(p=>p.registrationPending)).toBe(false);
 expect(m.creates).toBe(owner?1:0);
});
it.each([false,true])('actual mode change correctly retains pending owner=%s',async(owner)=>{
 const {server,bracket}=await boot(owner);const admission=await bracket.ensureBracketHost();
 server.observeServerInfo(server.beginServerInfoRequest(),{...info,simulation:false});
 await expect(bracket.registerBracket(spec,admission)).rejects.toThrow('環境已變更');
 expect(bracket.getDisplayBrackets().filter(p=>p.registrationPending)).toHaveLength(1);expect(m.creates).toBe(0);
});
it.each([false,true])('same-mode info refresh before entry preserves admission for owner=%s',async(owner)=>{
 const {server,bracket}=await boot(owner);const admission=await bracket.ensureBracketHost();
 server.observeServerInfo(server.beginServerInfoRequest(),{...info});
 expect(()=>bracket.assertBracketAdmission(admission)).not.toThrow();
});
it('native re-enable must await acknowledgement for the current toggle generation',async()=>{
 const {native,bracket}=await boot(true);
 const pending = new Promise<never>(()=>{});
 native.__setNativeInvokeForTest(()=>pending,{enabled:true,desktop:true});
 native.setNativeExecutionEnabled(false);native.setNativeExecutionEnabled(true);
 // No execution_set_enabled ACK has established this new owner generation.
 await expect(bracket.ensureBracketHost()).rejects.toThrow();
});

it.each([false,true])('r34 same-mode real server restart invalidates both owners %s',async(owner)=>{
 const {server,bracket}=await boot(owner);const admission=await bracket.ensureBracketHost();
 server.observeServerInfo(server.beginServerInfoRequest(),{...info,instance_id:'fixture-session-2'});
 expect(()=>bracket.assertBracketAdmission(admission)).toThrow();
 await expect(bracket.registerBracket(spec,admission)).rejects.toThrow('環境已變更');
 expect(bracket.getDisplayBrackets().filter(p=>p.registrationPending)).toHaveLength(1);expect(m.creates).toBe(0);
});
it.each([false,true])('r34 away/back and a down/live session both retire admissions %s',async(owner)=>{
 const {server,bracket}=await boot(owner);const admission=await bracket.ensureBracketHost();
 server.observeServerInfo(server.beginServerInfoRequest(),{...info,simulation:false});
 server.observeServerInfo(server.beginServerInfoRequest(),info);
 expect(()=>bracket.assertBracketAdmission(admission)).toThrow();
 const fresh=await bracket.ensureBracketHost();
 m.status='down';m.callbacks.forEach(cb=>cb());m.status='live';m.callbacks.forEach(cb=>cb());
 expect(()=>bracket.assertBracketAdmission(fresh)).toThrow();
});
it.each([false,true])('r34 ordinary status publication is not a session change %s',async(owner)=>{
 const {bracket}=await boot(owner);const admission=await bracket.ensureBracketHost();
 m.callbacks.forEach(cb=>cb());expect(()=>bracket.assertBracketAdmission(admission)).not.toThrow();
 await expect(bracket.registerBracket(spec,admission)).resolves.toMatchObject({seqno:spec.seqno});
});
