// scripts/chart-fills-demo/main.tsx — K 線成交標記示範頁（假資料；啟動方式見同目錄 vite.config.ts）
// Dev-only fixture. Install all transport guards before importing app modules.
// 壓力模式：?stress=N&live=R&quote=Q&mirror=1，quote 每秒最多 200 次合成報價。
// window.__stressStop() 停止回報、報價與鏡像；__stressStats() 回傳 { fills, quotes, total }。
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import type { ContractInfo } from '../../src/lib/types/contract';
import type { KBars, SseTick } from '../../src/lib/types/market';
import type { AccountedTrade, Deal } from '../../src/lib/types/order';
import type { Account } from '../../src/lib/types/portfolio';
import '../../src/index.css';
import './main.css';

if (!import.meta.env.DEV) throw new Error('This fixture is available only in development.');
if ('__TAURI_INTERNALS__' in window) throw new Error('Open this fixture in a browser.');

// Keep even the real stores' preferences in this page's memory. Fixture data
// never touches the user's saved accounts, chart drawings, or theme.
const memory = new Map<string, string>();
const previewStorage: Storage = {
    get length() { return memory.size; },
    clear: () => memory.clear(),
    getItem: key => memory.get(key) ?? null,
    key: index => Array.from(memory.keys())[index] ?? null,
    removeItem: key => { memory.delete(key); },
    setItem: (key, value) => { memory.set(key, String(value)); },
};
Object.defineProperty(window, 'localStorage', { configurable: true, value: previewStorage });
const params = new URLSearchParams(location.search);
const stressCount = Math.max(0, Math.min(200_000, Number(params.get('stress')) || 0));
const stressLive = Math.max(0, Math.min(200, Number(params.get('live')) || 0));
const stressQuote = stressCount ? Math.max(0, Math.min(200, Number(params.get('quote')) || 0)) : 0;
// 原生通道與鎖會影響同來源的完整終端機；壓力報價模式改用分頁內假實作，讓 stream 能取得所有權。
// 假通道不傳訊息、假鎖不碰原生鎖，因此不會干擾其他分頁；其餘模式維持停用。
(window as unknown as { BroadcastChannel?: unknown }).BroadcastChannel = stressQuote ? class {
    addEventListener() {}
    removeEventListener() {}
    postMessage() {}
    close() {}
} : undefined;
Object.defineProperty(navigator, 'locks', { configurable: true, value: stressQuote ? {
    async request(name: string, optionsOrCallback: LockOptions | LockGrantedCallback<unknown>, callback?: LockGrantedCallback<unknown>) {
        return (typeof optionsOrCallback === 'function' ? optionsOrCallback : callback!)({ name, mode: 'exclusive' });
    },
} : undefined });

const accounts: Account[] = [
    { account_type: 'S', person_id: 'DEMO', broker_id: 'DEMO-A', account_id: '0000001', signed: true, username: '示範帳戶 A' },
    { account_type: 'S', person_id: 'DEMO', broker_id: 'DEMO-B', account_id: '0000002', signed: true, username: '示範帳戶 B' },
];
const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
const contracts: ContractInfo[] = [
    { region: 'TW', exchange: 'TSE', code: '2330', security_type: 'STK', target_code: null, name: '台積電', currency: 'TWD', limit_up: 1050, limit_down: 860, reference: 955, day_trade: 'Yes', update_date: today, category: '24', margin_trading_balance: 0, short_selling_balance: 0 },
    { region: 'TW', exchange: 'TSE', code: '2317', security_type: 'STK', target_code: null, name: '鴻海', currency: 'TWD', limit_up: 220, limit_down: 180, reference: 200, day_trade: 'Yes', update_date: today, category: '24', margin_trading_balance: 0, short_selling_balance: 0 },
];

// &mirror=1：每秒把整份委託換成內容相同的複本，模擬彈出視窗每秒收到主視窗的鏡像
const stressMirror = params.get('mirror') === '1';
const stressStats = { fills: 0, quotes: 0, total: stressCount };
const stressTimers = new Set<ReturnType<typeof setInterval>>();
declare global {
    interface Window {
        __stressStop?: () => void;
        __stressStats?: () => { fills: number; quotes: number; total: number };
    }
}
if (stressCount) {
    window.__stressStop = () => {
        stressTimers.forEach(timer => clearInterval(timer));
        stressTimers.clear();
    };
    window.__stressStats = () => ({ ...stressStats });
}

// Deterministic one-minute, close-label-right OHLC fixtures; fills use the
// corresponding Taipei session in Unix seconds, just like status.deals.
function priceAt(code: string, minute: number, daysAgo = 0) {
    const base = code === '2330' ? 955 : 200;
    const tick = code === '2330' ? 1 : 0.5;
    const wave = Math.sin(minute / 25) * 4 + Math.sin(minute / 7) * 1.3;
    return Math.round((base + (minute / 270) * 11 + wave - daysAgo * 0.6) / tick) * tick;
}
function fixtureKbars(code: string, start: string, end: string): KBars {
    const result: KBars = { datetime: [], Open: [], High: [], Low: [], Close: [], Volume: [], Amount: [] };
    for (let daysAgo = 24; daysAgo >= 0; daysAgo--) {
        const date = new Date(`${today}T00:00:00Z`);
        date.setUTCDate(date.getUTCDate() - daysAgo);
        const day = date.toISOString().slice(0, 10);
        if (day < start || day > end || (daysAgo > 0 && [0, 6].includes(date.getUTCDay()))) continue;
        for (let minute = 1; minute <= 270; minute++) {
            const label = new Date(`${day}T09:00:00Z`);
            label.setUTCMinutes(label.getUTCMinutes() + minute);
            const open = priceAt(code, minute - 1, daysAgo);
            const close = priceAt(code, minute, daysAgo);
            const tick = code === '2330' ? 1 : 0.5;
            const volume = 18 + (minute * 37 + daysAgo * 11) % 160;
            result.datetime.push(label.toISOString().slice(0, 19).replace('T', ' '));
            result.Open.push(open);
            result.High.push(Math.max(open, close) + tick * (minute % 3 === 0 ? 2 : 1));
            result.Low.push(Math.min(open, close) - tick);
            result.Close.push(close);
            result.Volume.push(volume);
            result.Amount.push(close * volume * 1000);
        }
    }
    return result;
}

// 固定假資料到 13:30；報價壓力模式把尾棒對齊現在，盤前／盤後也能測同棒更新與跨分鐘開棒。
function quoteKbars(bars: KBars): KBars {
    if (!stressQuote || !bars.datetime.length || bars.datetime.at(-1)!.slice(0, 10) !== today) return bars;
    const label = new Date(Math.floor(Date.now() / 60_000) * 60_000 + 60_000 + 8 * 3600_000)
        .toISOString().slice(0, 19).replace('T', ' ');
    const tail = bars.datetime.length - 1;
    const keep = bars.datetime.filter(t => t < label).length;
    return Object.fromEntries(Object.entries(bars).map(([key, values]) => [key,
        [...values.slice(0, keep), key === 'datetime' ? label : values[tail]],
    ])) as unknown as KBars;
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json' },
});
window.fetch = async (input, init) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(request?.url ?? String(input), location.href);
    const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
    if (url.pathname === '/api/v1/auth/accounts' && method === 'GET') return json(accounts);
    if (url.pathname === '/api/v1/data/kbars' && method === 'POST') {
        const body = JSON.parse(typeof init?.body === 'string' ? init.body : await request?.text() ?? '{}') as { contract?: { code?: string }; start?: string; end?: string };
        if (!contracts.some(c => c.code === body.contract?.code)) return json({ detail: 'Unknown fixture symbol' }, 404);
        return json(quoteKbars(fixtureKbars(body.contract!.code!, body.start ?? today, body.end ?? today)));
    }
    // Do not delegate to the original fetch, including order mutations.
    return json({ detail: '示範頁已封鎖此請求' }, 403);
};

// useQuote 仍走真正的 stream store；只有壓力報價模式派送本機事件，永遠不開 socket。
const fixtureSources = new Set<FixtureEventSource>();
class FixtureEventSource extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSED = 2;
    readonly withCredentials = false;
    readyState = FixtureEventSource.CLOSED;
    onopen: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    private openTimer?: ReturnType<typeof setTimeout>;
    constructor(readonly url: string) {
        super();
        if (!stressQuote) return;
        this.readyState = FixtureEventSource.CONNECTING;
        fixtureSources.add(this);
        // 等 stream 裝好 onopen 與具名事件 listener。
        this.openTimer = setTimeout(() => {
            this.readyState = FixtureEventSource.OPEN;
            const event = new Event('open');
            this.dispatchEvent(event);
            this.onopen?.(event);
            this.dispatchEvent(new MessageEvent('heartbeat', { data: '{}' }));
        }, 0);
    }
    close() {
        clearTimeout(this.openTimer);
        fixtureSources.delete(this);
        this.readyState = FixtureEventSource.CLOSED;
    }
}
window.EventSource = FixtureEventSource as unknown as typeof EventSource;

// 預設是今天、落在標籤 minute+1 那根 1 分 K 的收盤價；day／price 讓密集情境指定其他交易日與區間內的價格。
function deal(seq: string, code: string, minute: number, quantity: number, second = 12, day = today, price?: number): Deal {
    const daysAgo = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86400_000);
    return {
        seq,
        ts: Date.parse(`${day}T09:00:00+08:00`) / 1000 + minute * 60 + second,
        price: price ?? priceAt(code, minute + 1, daysAgo), quantity,
    };
}
function trade(id: string, account: Account, contract: ContractInfo, action: 'Buy' | 'Sell', deals: Deal[], odd = false, cancelled = false): AccountedTrade {
    const quantity = deals.reduce((sum, d) => sum + d.quantity, 0);
    return {
        account, contract,
        order: { id, seqno: id, ordno: id, action, price: deals[0]!.price, quantity: quantity + (cancelled ? 1 : 0), order_type: 'ROD', price_type: 'LMT', order_lot: odd ? 'IntradayOdd' : 'Common', order_cond: 'Cash', account },
        status: { id, status: cancelled ? 'Cancelled' : 'Filled', status_code: '00', order_quantity: quantity + (cancelled ? 1 : 0), deal_quantity: quantity, cancel_quantity: cancelled ? 1 : 0, modified_price: 0, msg: '', deals },
    };
}
const initialTrades: AccountedTrade[] = contracts.flatMap(contract => {
    const code = contract.code;
    return [
        trade(`${code}-A-buy`, accounts[0]!, contract, 'Buy', [deal(`${code}-01`, code, 183, 1), deal(`${code}-02`, code, 184, 2)]),
        trade(`${code}-A-sell`, accounts[0]!, contract, 'Sell', [deal(`${code}-03`, code, 222, 1)]),
        trade(`${code}-A-odd`, accounts[0]!, contract, 'Buy', [deal(`${code}-04`, code, 239, 300)], true),
        trade(`${code}-A-cancel`, accounts[0]!, contract, 'Sell', [deal(`${code}-05`, code, 252, 1)], false, true),
        trade(`${code}-B-buy`, accounts[1]!, contract, 'Buy', [deal(`${code}-06`, code, 208, 2)]),
        trade(`${code}-B-sell`, accounts[1]!, contract, 'Sell', [deal(`${code}-07`, code, 246, 1)]),
    ];
});

// 「密集成交」情境：只給示範帳戶 A 與目前商品，由固定公式與 1 分 K 推算（不用亂數，每次載入相同）。
// 每筆價格都取自它所在那根 1 分 K 的 Low–High，5m／15m／日 K 的區間必然包含它，不為版面調整價格。
const DENSE_VIEW_DAYS = 2; // 預設 5m 視圖約顯示最近兩個交易日；實際畫面天數不同時改這個值
interface FixtureBar { day: string; m: number; high: number; low: number; close: number } // m：距 09:00 的整分鐘，落在標籤 m+1 那根
function denseTrades(contract: ContractInfo): AccountedTrade[] {
    const code = contract.code;
    const tick = code === '2330' ? 1 : 0.5;
    const kbars = fixtureKbars(code, '', today);
    const days = [...new Set(kbars.datetime.map(t => t.slice(0, 10)))].slice(-DENSE_VIEW_DAYS);
    const bars: FixtureBar[] = kbars.datetime.flatMap((t, i) => days.includes(t.slice(0, 10)) ? [{
        day: t.slice(0, 10), m: Number(t.slice(11, 13)) * 60 + Number(t.slice(14, 16)) - 541,
        high: kbars.High[i]!, low: kbars.Low[i]!, close: kbars.Close[i]!,
    }] : []);
    const bar = (day: string, m: number) => bars.find(b => b.day === day && b.m === m)!;
    const inBar = (b: FixtureBar, price: number) => Math.min(b.high, Math.max(b.low, Math.round(price / tick) * tick));
    const out: AccountedTrade[] = [];
    const fill = (tag: string, action: 'Buy' | 'Sell', b: FixtureBar, quantity: number, second: number, price: number, odd = false) =>
        out.push(trade(`dense-${code}-${tag}`, accounts[0]!, contract, action, [deal(`${tag}-01`, code, b.m, quantity, second, b.day, price)], odd));

    // 1. 連續 18 分鐘、每分鐘 2–4 筆，買賣交錯；價格依序取該分 K 區間內的不同位置
    const spots = [0.5, 0.15, 0.85, 0.3, 0.7];
    let n = 0;
    for (let j = 0; j < 18; j++) {
        const b = bar(today, 40 + j), count = 2 + j % 3;
        for (let t = 0; t < count; t++, n++) {
            fill(`run-${n}`, n % 2 ? 'Sell' : 'Buy', b, 1 + n % 3, Math.floor((t + 0.5) * 60 / count),
                inBar(b, b.low + (b.high - b.low) * spots[n % spots.length]!));
        }
    }
    // 2. 同一根 K 棒：同價一買一賣；同一根 K 棒三個價（上、中、下），挑區間最寬的一根
    const pair = bar(today, 70);
    fill('pair-buy', 'Buy', pair, 1, 15, pair.close);
    fill('pair-sell', 'Sell', pair, 1, 45, pair.close);
    const wide = bars.filter(b => b.day === today && b.m >= 86 && b.m <= 106)
        .reduce((a, b) => b.high - b.low > a.high - a.low ? b : a);
    fill('stack-top', 'Buy', wide, 1, 10, wide.high);
    fill('stack-mid', 'Sell', wide, 1, 30, inBar(wide, (wide.high + wide.low) / 2));
    fill('stack-low', 'Buy', wide, 1, 50, wide.low);
    // 3. 畫面最高與最低各一筆（同值取最晚一根）；4. 另挑 Low 次低、且不同 5 分 K 的一根，落在底部成交量柱區
    const top = Math.max(...bars.map(b => b.high)), bottom = Math.min(...bars.map(b => b.low));
    const peak = bars.filter(b => b.high === top).at(-1)!;
    const trough = bars.filter(b => b.low === bottom).at(-1)!;
    const shallow = Math.min(...bars.filter(b => b.low > bottom).map(b => b.low));
    const bucket = (b: FixtureBar) => `${b.day}|${Math.ceil((b.m + 1) / 5)}`;
    const near = bars.filter(b => b.low === shallow && bucket(b) !== bucket(trough)).at(-1)!;
    fill('peak', 'Sell', peak, 1, 30, peak.high);
    fill('trough', 'Buy', trough, 1, 30, trough.low);
    fill('near-bottom', 'Buy', near, 1, 30, near.low);
    // 5. 部分成交：同一張買單分三筆，限價為首筆價；零股：盤中零股 87 股
    const slices = [150, 151, 153].map(m => bar(today, m));
    out.push(trade(`dense-${code}-part`, accounts[0]!, contract, 'Buy', slices.map((b, i) =>
        deal(`part-0${i + 1}`, code, b.m, [2, 1, 3][i]!, 20, today, inBar(b, slices[0]!.close)))));
    const odd = bar(today, 165);
    fill('odd', 'Buy', odd, 87, 25, odd.close, true);
    return out;
}

// 壓力測試：網址帶 ?stress=N（例如 20000）產生 N 筆示範帳戶 A 的成交，散在最近 DENSE_VIEW_DAYS 個交易日的
// 1 分 K 上（依時間先後、價格取自所在那根的 Low–High、每張委託 1–4 筆、買賣交錯，固定公式、每次相同）。再帶 &live=R
// 每秒在最新一根追加 R 筆成交，模擬盤中連續回報（每筆都換掉那張委託物件，跟交易狀態的更新方式一樣）。
function stressTrades(contract: ContractInfo, n: number): AccountedTrade[] {
    const code = contract.code;
    const tick = code === '2330' ? 1 : 0.5;
    const kbars = fixtureKbars(code, '', today);
    const days = [...new Set(kbars.datetime.map(t => t.slice(0, 10)))].slice(-DENSE_VIEW_DAYS);
    const bars = kbars.datetime.flatMap((t, i) => days.includes(t.slice(0, 10)) ? [{
        day: t.slice(0, 10), m: Number(t.slice(11, 13)) * 60 + Number(t.slice(14, 16)) - 541, high: kbars.High[i]!, low: kbars.Low[i]!,
    }] : []);
    const out: AccountedTrade[] = [];
    for (let k = 0, id = 0; k < n; id++) {
        const deals: Deal[] = [];
        for (let j = 0; j < 1 + id % 4 && k < n; j++, k++) {
            const b = bars[Math.floor((k * bars.length) / n)]!; // 依時間先後，跟真實一天的回報順序一樣
            const steps = Math.max(0, Math.round((b.high - b.low) / tick));
            deals.push(deal(`stress-${id}-${j}`, code, b.m, 1 + k % 3, (k * 7) % 60, b.day, b.low + ((k * 7) % (steps + 1)) * tick));
        }
        out.push(trade(`stress-${code}-${id}`, accounts[0]!, contract, id % 2 ? 'Sell' : 'Buy', deals));
    }
    return out;
}

// 偏好模組載入時就讀 localStorage，要在換成記憶體 storage 之後才載入（不讀使用者真正的設定）
const [{ CandleChart }, theme, accountStore, fillPrefs, { vars }] = await Promise.all([
    import('../../src/components/candle-chart'),
    import('../../src/lib/theme-store'),
    import('../../src/lib/account-store'),
    import('../../src/lib/chart-fill-prefs'),
    import('../../src/theme.css'),
]);
theme.initTheme();
theme.setThemeSettings({ mode: 'dark', convention: 'tw', fontScale: 1 });
await accountStore.refreshAccounts();

function Preview() {
    const [code, setCode] = useState('2330');
    const [trades, setTrades] = useState(() => stressCount ? stressTrades(contracts[0]!, stressCount) : initialTrades);
    // 壓力測試的即時回報：每秒 stressLive 筆，都加在最後一張委託、落在最新一根 1 分 K
    useEffect(() => {
        if (!stressCount || !stressLive) return;
        let n = 0;
        const timer = setInterval(() => {
            const seq = n++;
            const ts = Date.now() / 1000;
            stressStats.fills++;
            stressStats.total++;
            setTrades(previous => {
                const last = previous[previous.length - 1]!;
                const extra = deal(`live-${seq}`, last.contract.code, 268, 1, (seq + 1) % 60, today);
                if (stressQuote) extra.ts = ts;
                return [...previous.slice(0, -1), { ...last, status: { ...last.status, deal_quantity: last.status.deal_quantity + 1, deals: [...last.status.deals, extra] } }];
            });
        }, 1000 / stressLive);
        stressTimers.add(timer);
        return () => { clearInterval(timer); stressTimers.delete(timer); };
    }, []);
    useEffect(() => {
        if (!stressCount || !stressMirror) return;
        const timer = setInterval(() => setTrades(previous => structuredClone(previous)), 1000);
        stressTimers.add(timer);
        return () => { clearInterval(timer); stressTimers.delete(timer); };
    }, []);
    useEffect(() => {
        if (!stressQuote) return;
        const bars = quoteKbars(fixtureKbars(code, today, today));
        const high = bars.High.at(-1)!, low = bars.Low.at(-1)!;
        let n = 0;
        const timer = setInterval(() => {
            const sources = [...fixtureSources].filter(source => source.readyState === FixtureEventSource.OPEN);
            if (!sources.length) return;
            const now = new Date(Date.now() + 8 * 3600_000).toISOString();
            const close = low + (high - low) * (0.5 + Math.sin(n++ / 5) * 0.25);
            const tick: SseTick = {
                code, date: now.slice(0, 10), time: now.slice(11, 23),
                open: String(bars.Open.at(-1)!), high: String(high), low: String(low), close: String(close),
                volume: 1, total_volume: n, tick_type: n % 2 ? 1 : 2, simtrade: false,
            };
            sources.forEach(source => source.dispatchEvent(new MessageEvent('tick_stk', { data: JSON.stringify(tick) })));
            stressStats.quotes++;
        }, 1000 / stressQuote);
        stressTimers.add(timer);
        return () => { clearInterval(timer); stressTimers.delete(timer); };
    }, [code]);
    const [added, setAdded] = useState(false);
    const [dense, setDense] = useState(false);
    // 待確認：圖上保留上次確認的淡色標記、明細不列
    const [pending, setPending] = useState(false);
    const fillStyle = fillPrefs.useChartFillStyle();
    const fillScope = fillPrefs.useChartFillScope();
    const [message, setMessage] = useState('買進、賣出、同棒多筆、零股，以及部分成交後撤單。');
    const { selectedStock } = accountStore.useAccounts();
    const settings = theme.useThemeSettings();
    const contract = contracts.find(c => c.code === code)!;
    // 密集成交只在這裡串接給圖表，不進 trades 狀態：關閉即移除，也不影響「新增一筆」的成交。
    const denseRows = useMemo(() => denseTrades(contract), [contract]);
    const shownTrades = useMemo(() => dense ? [...trades, ...denseRows] : trades, [dense, trades, denseRows]);
    const tokens = {
        '--preview-bg': vars.color.background,
        '--preview-panel': vars.color.panel,
        '--preview-raised': vars.color.panelRaised,
        '--preview-fg': vars.color.foreground,
        '--preview-muted': vars.color.mutedForeground,
        '--preview-border': vars.color.border,
        '--preview-accent': vars.color.accent,
        '--preview-accent-dim': vars.color.accentDim,
        '--preview-amber': vars.color.amber,
    } as CSSProperties;
    const addFill = () => {
        if (!selectedStock || added) return;
        if (stressCount) stressStats.total++;
        setTrades(previous => [...previous, trade(`${code}-added`, selectedStock, contract, 'Buy', [deal(`${code}-added-01`, code, 263, 1)])]);
        setAdded(true);
        setMessage(`已新增 ${contract.code} 13:23:12 買進 1 張示範成交；切換帳戶或商品可檢查隔離。`);
    };
    const toggleDense = () => {
        setDense(!dense);
        setMessage(dense ? '已關閉密集成交，回到固定示範資料。'
            : `密集成交（僅示範帳戶 A，${denseRows.reduce((sum, t) => sum + t.status.deals.length, 0)} 筆）：連續 18 分鐘買賣交錯、同棒同價與三價、畫面最高最低、近底部、分筆成交與零股。`);
    };
    return (
        <main className="preview-shell" style={tokens}>
            <header className="preview-header">
                <div className="preview-title">
                    <strong>K 線成交標記</strong>
                    <span className="preview-badge">示範成交資料</span>
                </div>
                <span className="preview-date">{today} · 台北時間</span>
            </header>
            <section className="preview-controls" aria-label="示範資料控制">
                <label>商品
                    <select value={code} onChange={event => setCode(event.target.value)}>
                        {contracts.map(c => <option key={c.code} value={c.code}>{c.code} {c.name}</option>)}
                    </select>
                </label>
                <label>主帳戶
                    <select value={selectedStock?.account_id ?? ''} onChange={event => accountStore.selectAccount(accounts.find(a => a.account_id === event.target.value)!)}>
                        {accounts.map(a => <option key={a.account_id} value={a.account_id}>{a.username}</option>)}
                    </select>
                </label>
                <div className="preview-theme" aria-label="色彩主題">
                    <button aria-pressed={settings.mode === 'dark'} onClick={() => theme.setThemeSettings({ mode: 'dark' })}>深色</button>
                    <button aria-pressed={settings.mode === 'light'} onClick={() => theme.setThemeSettings({ mode: 'light' })}>淺色</button>
                </div>
                <label>標籤
                    <select value={fillStyle} onChange={event => fillPrefs.setChartFillStyle(event.target.value as typeof fillStyle)}>
                        <option value="dot">不標</option>
                        <option value="side">買賣</option>
                        <option value="price">價格</option>
                    </select>
                </label>
                <label>顯示帳戶
                    <select value={fillScope} onChange={event => fillPrefs.setChartFillScope(event.target.value as typeof fillScope)}>
                        <option value="active">目前帳戶</option>
                        <option value="all">全部帳戶</option>
                    </select>
                </label>
                <button className="preview-dense" aria-pressed={dense} onClick={toggleDense}>密集成交</button>
                <button aria-pressed={pending} onClick={() => setPending(!pending)}>待確認</button>
                <button className="preview-add" disabled={added} onClick={addFill}>{added ? '已新增示範成交' : '新增一筆示範成交'}</button>
            </section>
            <section className="preview-chart" aria-label={`${contract.code} ${contract.name} K 線圖`}>
                <CandleChart panelId="chart-fills-fixture" contract={contract} trades={shownTrades} fillsReady={!pending} fillsRetain fillsEnv="fixture" />
            </section>
            <footer className="preview-footer">
                <span role="status" aria-live="polite">{message}</span>
                <span>僅供畫面驗證 · 資料不保存 · 未連接交易服務</span>
            </footer>
        </main>
    );
}

createRoot(document.getElementById('root')!).render(<Preview />);
