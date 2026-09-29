// Read-only live verification. Never submits orders, login, or account queries.
import fs from 'node:fs';
import assert from 'node:assert/strict';
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const base = `http://${config.host}:${config.port}`;
const paired = await fetch(`${base}/pair`, {method:'POST', body:new URLSearchParams({code:config.pairCode}), redirect:'manual'});
assert.equal(paired.status, 303);
const headers = {cookie:paired.headers.get('set-cookie').split(';')[0]};
assert.equal((await fetch(base, {headers})).status, 200);
const health = await fetch(`${base}/api/v1/health`, {headers});
assert.equal(health.status, 200);
console.log('Authenticated page and sanitized health: OK');
let count = 0;
for (const name of fs.readdirSync(config.root).filter(n=>/\.(js|css)$/.test(n))) {
  const r=await fetch(`${base}/${name}`, {headers,method:'HEAD'});
  assert.equal(r.status,200,name); count++;
}
console.log(`Production JS/CSS assets reachable: ${count}`);
const control = new AbortController();
const timeout = setTimeout(()=>control.abort(), 15000);
const seen = new Set();
try {
  const stream = await fetch(`${base}/api/v1/stream/data`, {headers,signal:control.signal});
  assert.equal(stream.status,200);
  const decoder = new TextDecoder(); let buffer='';
  for await(const chunk of stream.body) {
    buffer+=decoder.decode(chunk,{stream:true});
    for(const match of buffer.matchAll(/event: ([A-Za-z_]+)/g))seen.add(match[1]);
    if(seen.has('heartbeat'))break;
  }
} catch(e) { if(e.name!=='AbortError')throw e; }
finally { clearTimeout(timeout); control.abort(); }
assert.ok(seen.has('heartbeat'),'No heartbeat received within 15 seconds');
console.log(`Live sanitized SSE received: ${[...seen].join(', ')}`);
