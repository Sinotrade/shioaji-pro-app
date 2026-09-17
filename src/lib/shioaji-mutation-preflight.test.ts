import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Account } from './types/portfolio';
import type { AccountedTrade } from './types/order';
const m = vi.hoisted(() => ({ base:'fixture',rows:[] as AccountedTrade[],accounts:[] as Account[],post:vi.fn() }));
vi.mock('./runtime', async original => ({...await original<object>(),getApiBase:()=>m.base}));
vi.mock('./api',()=>({
 apiPost:m.post,
 apiGet:vi.fn(async()=>({name:'fixture',version:'fixture',description:'',protocols:[],simulation:true})),
 apiPut:vi.fn(),
 apiDelete:vi.fn(),
}));
vi.mock('./account-store',()=>({accountFor:vi.fn(()=>{throw new Error('no selected fallback');}),getAccountState:()=>({accounts:m.accounts})}));
vi.mock('./trading-state',()=>({getTradingState:()=>({trades:m.rows})}));
import { cancelOrder, updateOrderPrice, updateOrderQty } from './shioaji';
const account:Account={account_type:'F',broker_id:'fixture',account_id:'owner',signed:true,username:'',person_id:''};
const row = ():AccountedTrade => ({account,contract:{code:'QEFI6',security_type:'FUT',exchange:'TAIFEX',target_code:null},order:{id:'fixture',action:'Buy',price:489,seqno:'seq',ordno:'ord',quantity:3,account},status:{status:'Submitted',id:'fixture',status_code:'00',msg:'',order_ts:1700000000,order_quantity:3,modified_price:0,deals:[],deal_quantity:0,cancel_quantity:0}} as AccountedTrade);
const cancelledRow = ():AccountedTrade => ({...row(),status:{...row().status,status:'Cancelled',cancel_quantity:3}});
beforeEach(()=>{vi.clearAllMocks();m.base='fixture';m.accounts=[account];m.rows=[row()];let tradeReads=0;m.post.mockImplementation(async path=>{
 if(path==='/api/v1/order/trades'){tradeReads++;return tradeReads===1?[row()]:[cancelledRow()];}return row();});
 vi.stubGlobal('navigator',{locks:{request:(_n: string,_o:unknown,cb:(v:object)=>unknown)=>cb({})}});
});
afterEach(()=>vi.unstubAllGlobals());
it.each([['cancel',3,()=>cancelOrder('fixture')],['price',2,()=>updateOrderPrice('fixture',489)],['quantity',2,()=>updateOrderQty('fixture',1)]] as const)('preflights exact owner once before futures %s',async(_name,calls,call)=>{
 await call();expect(m.post.mock.calls[0]).toEqual(['/api/v1/order/trades',{account_type:'F',broker_id:'fixture',account_id:'owner'}]);
 expect(m.post).toHaveBeenCalledTimes(calls);expect(m.post.mock.calls[1]![1].trade_id).toBe('fixture');
});
it('preserves quantity intent',async()=>{await updateOrderQty('fixture',1);expect(m.post.mock.calls[1]![1]).toEqual({trade_id:'fixture',quantity:1});});
it('does not preflight-query stocks but does verify the cancellation afterwards',async()=>{const stock={...account,account_type:'S'};m.accounts=[stock];m.rows=[{...row(),account:stock,order:{...row().order,account:stock},contract:{code:'2330',security_type:'STK',exchange:'TSE',target_code:null}} as AccountedTrade];m.post.mockImplementation(async path=>path==='/api/v1/order/trades'?[]:row());await cancelOrder('fixture');expect(m.post).toHaveBeenCalledTimes(2);expect(m.post.mock.calls[0]![0]).toBe('/api/v1/order/cancel_order');expect(m.post.mock.calls[1]![0]).toBe('/api/v1/order/trades');});
it.each(['missing','other-account','terminal','zero','identifiers','base-change','query-failure','partial','reduced','live-changed','action','latest-failed'])('does not mutate after %s reconciliation',async mode=>{
 const snapshot=row();if(mode==='other-account')snapshot.order.account={...account,account_id:'other'};
 if(mode==='terminal')snapshot.status.status='Cancelled';if(mode==='zero')snapshot.status.cancel_quantity=3;
 if(mode==='identifiers')snapshot.order.ordno='';
 if(mode==='action')snapshot.order.action='Sell';
 if(mode==='partial')snapshot.status.deal_quantity=1;if(mode==='reduced')snapshot.status.cancel_quantity=1;
 if(mode==='live-changed')m.post.mockReset();
 m.post.mockImplementation(async()=>{if(mode==='latest-failed')m.rows=[{...row(),status:{...row().status,status:'Failed'}}];if(mode==='live-changed')m.rows=[{...row(),status:{...row().status,deal_quantity:1}}];if(mode==='base-change')m.base='other';if(mode==='query-failure')throw new Error('network');return mode==='missing'?[]:[snapshot];});
 await expect(cancelOrder('fixture')).rejects.toThrow();expect(m.post).toHaveBeenCalledTimes(1);
});
it('does not guess an unknown trade or account',async()=>{m.rows=[];await expect(cancelOrder('fixture')).rejects.toThrow();expect(m.post).not.toHaveBeenCalled();});
it('holds the local gate during reconciliation and never queues a second mutation',async()=>{
	let resolve!:(v:AccountedTrade[])=>void;m.post.mockImplementationOnce(()=>new Promise(r=>{resolve=r;})).mockResolvedValueOnce(row()).mockResolvedValueOnce([cancelledRow()]);
 const first=cancelOrder('fixture');await vi.waitFor(()=>expect(m.post).toHaveBeenCalledTimes(1));
 await expect(updateOrderQty('fixture',1)).rejects.toThrow('已有');resolve([row()]);await first;expect(m.post).toHaveBeenCalledTimes(3);
});

it('marks a failed reconciliation as not dispatched while preserving its error',async()=>{
 const failure=new Error('offline');m.post.mockRejectedValue(failure);
 await expect(cancelOrder('fixture')).rejects.toBe(failure);expect(failure).toHaveProperty('mutationNotStarted',true);
});
it('rejects contradictory embedded account identity',async()=>{
 m.rows=[{...row(),order:{...row().order,account:{...account,account_id:'other'}}}];
 await expect(cancelOrder('fixture')).rejects.toThrow('矛盾');expect(m.post).not.toHaveBeenCalled();
});

it.each(['seqno','ordno'] as const)('rejects a snapshot replacing known %s',async key=>{
 const changed=row();changed.order[key]='different';m.post.mockResolvedValue([changed]);
 await expect(cancelOrder('fixture')).rejects.toMatchObject({mutationNotStarted:true});expect(m.post).toHaveBeenCalledTimes(1);
});
it.each(['seqno','ordno'] as const)('rejects latest SSE replacing known %s while query runs',async key=>{
 m.post.mockImplementation(async()=>{const changed=row();changed.order[key]='different';m.rows=[changed];return [row()];});
 await expect(cancelOrder('fixture')).rejects.toMatchObject({mutationNotStarted:true});expect(m.post).toHaveBeenCalledTimes(1);
});
it('allows reconciliation to hydrate empty baseline identifiers',async()=>{
	m.rows=[{...row(),order:{...row().order,seqno:'',ordno:''}}];await cancelOrder('fixture');expect(m.post).toHaveBeenCalledTimes(3);
});
it('rejects disagreement between newly hydrated latest SSE and snapshot identifiers',async()=>{
 m.rows=[{...row(),order:{...row().order,seqno:'',ordno:''}}];
 m.post.mockImplementation(async()=>{m.rows=[{...row(),order:{...row().order,seqno:'other'}}];return [row()];});
 await expect(cancelOrder('fixture')).rejects.toMatchObject({mutationNotStarted:true});expect(m.post).toHaveBeenCalledTimes(1);
});
it.each(['type','embedded'] as const)('rejects latest account %s change even when amounts match',async mode=>{
 m.post.mockImplementation(async()=>{const changed=row();if(mode==='type'){changed.account={...account,account_type:'S'};changed.order.account=changed.account;}else changed.order.account={...account,account_id:'other'};m.rows=[changed];return [row()];});
 await expect(cancelOrder('fixture')).rejects.toMatchObject({mutationNotStarted:true});expect(m.post).toHaveBeenCalledTimes(1);
});
