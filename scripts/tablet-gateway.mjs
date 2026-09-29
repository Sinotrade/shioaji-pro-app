// LAN-only, default-deny market-data gateway. Never proxy a generic API prefix.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const events = new Set(['tick_stk', 'tick_fop', 'bidask_stk', 'bidask_fop', 'quote_idx', 'heartbeat']);
export function filterEvent(frame) {
  const lines = frame.replace(/\r/g, '').split('\n');
  const eventLines = lines.filter(l => l.startsWith('event:'));
  if (eventLines.length !== 1) return '';
  const event = eventLines[0].slice(6).trim();
  if (!events.has(event)) return '';
  if (event === 'heartbeat') return 'event: heartbeat\ndata: {}\n\n';
  const data = lines.filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('\n');
  try { JSON.parse(data); } catch { return ''; }
  return `event: ${event}\ndata: ${data}\n\n`;
}
export function allowed(method, pathname) {
  if (method === 'GET') return /^\/api\/v1\/data\/contracts(?:\/[A-Za-z0-9_-]+){0,3}$/.test(pathname);
  return method === 'POST' && new Set(['/api/v1/data/snapshots', '/api/v1/data/kbars', '/api/v1/data/ticks', '/api/v1/data/scanner', '/api/v1/data/index_components', '/api/v1/stream/subscribe']).has(pathname);
}
export function localClient(ip, prefix = '192.168.1.') {
  return typeof ip === 'string' && ip.startsWith(prefix) && /^\d+$/.test(ip.slice(prefix.length)) && Number(ip.slice(prefix.length)) >= 1 && Number(ip.slice(prefix.length)) <= 254;
}
async function body(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 65536) throw Error('body limit'); chunks.push(chunk); }
  return Buffer.concat(chunks).toString('utf8');
}
export function createGateway({host, port, prefix, root, pairCode, upstream = 'http://127.0.0.1:21322'}) {
  const origin = `http://${host}:${port}`;
  const sessions = new Map(), attempts = new Map(), limits = new Map(), clients = new Set(), subscriptions = new Set();
  let streamReq = null, streamTimer = null;
  const json = (res, status, data) => { res.writeHead(status, {'Content-Type':'application/json; charset=utf-8'}); res.end(JSON.stringify(data)); };
  function connectStream() {
    if (!clients.size || streamReq) return;
    let buffer = '';
    const retry = () => { streamReq = null; if (clients.size && !streamTimer) streamTimer = setTimeout(() => {streamTimer = null; connectStream();}, 3000); };
    streamReq = http.get(`${upstream}/api/v1/stream/data?region=TW`, r => {
      if (r.statusCode !== 200) { r.resume(); retry(); return; }
      r.setEncoding('utf8');
      r.on('data', chunk => {
        buffer += chunk.replace(/\r\n/g,'\n');
        if (buffer.length > 1024 * 1024) { streamReq?.destroy(); return; }
        let at;
        while ((at = buffer.indexOf('\n\n')) >= 0) {
          const clean = filterEvent(buffer.slice(0, at)); buffer = buffer.slice(at + 2);
          if (clean) for (const c of clients) { if (!c.write(clean)) c.destroy(); }
        }
      });
      r.on('end', retry); r.on('error', retry);
    });
    streamReq.on('error', retry);
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options','nosniff'); res.setHeader('X-Frame-Options','DENY');
    // HTML form POST needs its same-origin Origin; no-referrer makes it null.
    // Keep rejecting null/foreign Origin rather than weakening the API guard.
    res.setHeader('Referrer-Policy','same-origin'); res.setHeader('Cache-Control','no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      if (!localClient(req.socket.remoteAddress, prefix) || req.headers.host !== `${host}:${port}`) return json(res,403,{error:'Home Wi-Fi only'});
      if ((req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site') return json(res,403,{error:'Origin denied'});
      const url = new URL(req.url, origin), p = url.pathname;
      const ip = req.socket.remoteAddress, now = Date.now();
      const limit = limits.get(ip) ?? {time:now,count:0}; if(now-limit.time>60000){limit.time=now;limit.count=0} limits.set(ip,limit);
      if (++limit.count>240) return json(res,429,{error:'Rate limited'});
      if (p === '/pair' && req.method === 'POST') {
        const tries = attempts.get(ip) ?? {time:now,count:0}; if(now-tries.time>600000){tries.time=now;tries.count=0} attempts.set(ip,tries);
        if (++tries.count > 8) return json(res,429,{error:'Too many attempts; wait 10 minutes'});
        const code = new URLSearchParams(await body(req)).get('code') ?? '';
        if (code.length !== pairCode.length || !crypto.timingSafeEqual(Buffer.from(code),Buffer.from(pairCode))) return json(res,403,{error:'配對碼錯誤'});
        const token = crypto.randomBytes(32).toString('hex'); sessions.set(token, now + 12*3600000);
        res.writeHead(303,{'Set-Cookie':`v9tablet=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`,'Location':'/'}); return res.end();
      }
      const cookie = (req.headers.cookie ?? '').split(';').map(s=>s.trim()).find(s=>s.startsWith('v9tablet='))?.slice(9);
      if (!cookie || (sessions.get(cookie) ?? 0)<now) {
        if (p.startsWith('/api/')) return json(res,401,{error:'Pair first'});
        res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
        return res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>V9 平板唯讀入口</title><body style="background:#111a28;color:#e4eaf4;font:18px system-ui;padding:40px;max-width:480px;margin:auto"><h2>V9 研究版 · 平板配對</h2><p>僅限家中 Wi-Fi，無下單與帳務權限。</p><form method="post" action="/pair"><label>電腦上的配對碼<br><input name="code" autocomplete="off" required style="font:24px monospace;width:100%;padding:12px;box-sizing:border-box"></label><button style="padding:12px;margin-top:18px;font:inherit">開啟唯讀看盤</button></form><p style="font-size:14px">電腦需保持開機；配對有效 12 小時。請勿在公共 Wi-Fi 使用。</p>');
      }
      if (p === '/api/v1/auth/accounts' && req.method === 'GET') return json(res,200,[]);
      if (p === '/api/v1/watchlist' && req.method === 'GET') return json(res,200,[]);
      if (p === '/api/v1/stream/unsubscribe' && req.method === 'POST') return json(res,200,{success:true,message:'Local view only; desktop subscriptions preserved'});
      if (p === '/api/v1/stream/data' && req.method === 'GET') {
        if(clients.size>=6) return json(res,429,{error:'Stream limit'});
        res.writeHead(200,{'Content-Type':'text/event-stream','Connection':'keep-alive'}); res.write(': V9 market-data only\n\n');
        clients.add(res); connectStream();
        const expiry=setTimeout(()=>res.end(),Math.max(1,sessions.get(cookie)-now));
        res.on('close',()=>{clearTimeout(expiry);clients.delete(res);if(!clients.size){streamReq?.destroy();streamReq=null;clearTimeout(streamTimer);streamTimer=null;}});return;
      }
      const metadata = req.method==='GET' && (p==='/api/v1/health'||p==='/api/v1/info');
      if (p.startsWith('/api/')) {
        if(!metadata && !allowed(req.method,p)) return json(res,403,{error:'Read-only gateway: endpoint denied'});
        let payload;
        if(req.method==='POST') {
          const value=JSON.parse(await body(req));
          if(p==='/api/v1/stream/subscribe') {
            if(!['STK','FUT','OPT','IND'].includes(value.security_type)||!['tick','bidask'].includes(String(value.quote_type).toLowerCase())||! /^[A-Za-z0-9_-]{1,24}$/.test(value.code??'')) return json(res,400,{error:'Unsupported quote subscription'});
            const key=`${value.security_type}:${value.code}:${value.quote_type}`;
            if(!subscriptions.has(key) && subscriptions.size>=80) return json(res,429,{error:'Quote limit'});
            payload=JSON.stringify({security_type:value.security_type,region:'TW',exchange:value.exchange,code:value.code,target_code:value.target_code||null,quote_type:value.quote_type,intraday_odd:false});
          } else {
            if(p.endsWith('/snapshots') && (!Array.isArray(value.contracts)||value.contracts.length>100)) return json(res,400,{error:'Snapshot limit'});
            if(p.endsWith('/kbars')) {const a=Date.parse(value.start),b=Date.parse(value.end);if(!Number.isFinite(a+b)||b<a||b-a>366*86400000) return json(res,400,{error:'History range limit'});}
            if(p.endsWith('/scanner') && (value.count??30)>100) return json(res,400,{error:'Scanner limit'});
            payload=JSON.stringify(value);
          }
        }
        const reply=await fetch(`${upstream}${p}${url.search}`,{method:req.method,headers:payload?{'Content-Type':'application/json'}:{},body:payload,redirect:'error',signal:AbortSignal.timeout(30000)});
        if(!reply.ok){await reply.body?.cancel();return json(res,reply.status,{error:'Market-data request unavailable'});}
        const data=await reply.json();
        if(metadata) {
          const keys=p.endsWith('/health')?['status','version','timestamp','token_stale','last_maintenance','session_recovering']:['version','simulation','protocols'];
          const safe=Object.fromEntries(keys.filter(k=>k in data).map(k=>[k,data[k]]));
          return json(res,200,p.endsWith('/info')?{...safe,name:'V9 Tablet Read-only',description:'Home Wi-Fi market data only'}:safe);
        }
        if(p==='/api/v1/stream/subscribe' && data.success){const v=JSON.parse(payload);subscriptions.add(`${v.security_type}:${v.code}:${v.quote_type}`);}
        return json(res,200,data);
      }
      if(req.method!=='GET'&&req.method!=='HEAD') return json(res,405,{error:'Method denied'});
      const name=p==='/'?'index.html':p.slice(1);
      // Production build emits flat files. Never expose source, maps or .env.
      if(!/^[A-Za-z0-9][A-Za-z0-9_.-]*\.(html|js|css|png|svg|ico|woff2)$/.test(name)||name.includes('..')||name==='approval.html') return json(res,404,{error:'Not found'});
      const file=path.join(root,name);if(!fs.existsSync(file)||!fs.statSync(file).isFile())return json(res,404,{error:'Not found'});
      const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.ico':'image/x-icon','.woff2':'font/woff2'};
      res.writeHead(200,{'Content-Type':mime[path.extname(file)]});if(req.method==='HEAD')return res.end();fs.createReadStream(file).pipe(res);
    }catch{if(!res.headersSent)json(res,502,{error:'Gateway request failed'});else res.end();}
  });
  server.requestTimeout=35000;server.headersTimeout=10000;
  server.on('close',()=>{clearTimeout(streamTimer);streamReq?.destroy();for(const c of clients)c.destroy();});
  return server;
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if(process.argv[2]==='--init') {
    const dir=path.resolve(process.argv[3]);fs.mkdirSync(dir,{recursive:true});
    const configFile=path.join(dir,'gateway.json');
    if(fs.existsSync(configFile))throw Error('Config exists; refusing to rotate pairing code');
    const pairCode=crypto.randomBytes(6).toString('hex');
    fs.writeFileSync(configFile,JSON.stringify({host:'192.168.1.122',port:5180,prefix:'192.168.1.',root:path.resolve(process.argv[4]),pairCode},null,2));
    fs.writeFileSync(path.join(dir,'pairing.html'),`<!doctype html><meta charset="utf-8"><title>V9 平板配對資料</title><body style="font:20px system-ui;padding:40px"><h2>V9 平板唯讀入口</h2><p>平板連接家中 L6175 5G Wi-Fi，再開啟 <a href="http://192.168.1.122:5180/">http://192.168.1.122:5180/</a></p><p>配對碼：<code>${pairCode}</code></p><p>只在自己的平板輸入，勿公開此檔。電腦需保持開機，配對有效 12 小時。</p></body>`);
    console.log('Created local gateway configuration and pairing.html (code not logged)');process.exit(0);
  }
  const config=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
  const server=createGateway(config);server.listen(config.port,config.host,()=>console.log(`V9 read-only tablet gateway listening on ${config.host}:${config.port}`));
}
