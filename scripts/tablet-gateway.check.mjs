import assert from 'node:assert/strict';
import http from 'node:http';
import {createGateway, allowed, localClient, filterEvent} from './tablet-gateway.mjs';
assert.equal(allowed('POST','/api/v1/order/place_order'),false);
assert.equal(allowed('GET','/api/v1/portfolio/account_balance'),false);
assert.equal(allowed('POST','/api/v1/auth/login'),false);
assert.equal(allowed('GET','/api/v1/data/contracts/2330/info'),true);
assert.equal(allowed('POST','/api/v1/data/kbars'),true);
assert.equal(localClient('8.8.8.8'),false);
assert.equal(localClient('192.168.10.1'),false);
assert.equal(localClient('192.168.1.999'),false);
assert.equal(localClient('192.168.1.42'),true);
assert.equal(filterEvent('event: order_event\ndata: {"account":"private"}'), '');
assert.equal(filterEvent('event: new_private_event\ndata: {}'), '');
assert.equal(filterEvent('event: heartbeat\ndata: {"secret":"hidden"}'), 'event: heartbeat\ndata: {}\n\n');
assert.equal(filterEvent('event: tick_stk\ndata: {"code":"2330"}'), 'event: tick_stk\ndata: {"code":"2330"}\n\n');
assert.equal(filterEvent('event: tick_stk\nevent: order_event\ndata: {}'), '');
const upstreamCalls=[];
const upstream=http.createServer((req,res)=>{upstreamCalls.push(req.url);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({status:'healthy',version:'test',token:'private',agent_harness:{bootstrap:'private'}}));});
await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
// Reserve a test port, then bind the gateway there. No real Shioaji calls.
const probe=http.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
const gateway=createGateway({host:'127.0.0.1',prefix:'127.0.0.',port,root:'/not-exposed',pairCode:'test-code',upstream:`http://127.0.0.1:${upstream.address().port}`});
await new Promise(r=>gateway.listen(port,'127.0.0.1',r));
try {
 const base=`http://127.0.0.1:${port}`;
 const page=await fetch(base);
 assert.equal(page.headers.get('referrer-policy'),'same-origin');
 for(const origin of ['null','https://evil.example']) {
   assert.equal((await fetch(base+'/pair',{method:'POST',headers:{Origin:origin},body:'code=test-code',redirect:'manual'})).status,403);
 }
 assert.equal((await fetch(base+'/api/v1/health')).status,401);
 assert.equal((await fetch(base+'/pair',{method:'POST',body:'code=wrong',redirect:'manual'})).status,403);
 const paired=await fetch(base+'/pair',{method:'POST',headers:{Origin:base,'Content-Type':'application/x-www-form-urlencoded'},body:'code=test-code',redirect:'manual'});
 assert.equal(paired.status,303);const cookie=paired.headers.get('set-cookie').split(';')[0];
 const headers={Cookie:cookie};
 for(const p of ['/api/v1/order/place_order','/api/v1/order/cancel_order','/api/v1/auth/login','/api/v1/server/stop','/api/v1/portfolio/margin','/api/v1/watchlist'])assert.equal((await fetch(base+p,{method:'POST',headers,body:'{}'})).status,403);
 assert.equal(upstreamCalls.length,0);
 assert.deepEqual(await (await fetch(base+'/api/v1/auth/accounts',{headers})).json(),[]);
 assert.equal((await fetch(base+'/api/v1/health',{headers:{...headers,Origin:'https://evil.example'}})).status,403);
 const health=await (await fetch(base+'/api/v1/health',{headers})).json();assert.deepEqual(health,{status:'healthy',version:'test'});
 assert.equal((await fetch(base+'/.env',{headers})).status,404);
 assert.equal((await fetch(base+'/src/lib/runtime.ts',{headers})).status,404);
 assert.equal((await fetch(base+'/api/v1/stream/unsubscribe',{method:'POST',headers,body:'{}'})).status,200);
 assert.equal(upstreamCalls.length,1);
 console.log('Gateway policy, pairing, origin, private-event filtering, static-file isolation and blocked-mutation checks passed (mock upstream only).');
}finally{gateway.closeAllConnections();upstream.closeAllConnections();await new Promise(r=>gateway.close(r));await new Promise(r=>upstream.close(r));}
