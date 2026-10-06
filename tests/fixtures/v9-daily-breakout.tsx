// Explicit synthetic QA data, no broker hooks, price stores or API requests.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ResearchDailyBreakoutPanel } from '../../src/components/research-daily-breakout-panel';
import type { ContractInfo } from '../../src/lib/types/contract';
import type { Candle } from '../../src/lib/types/market';
import { darkTwClass } from '../../src/theme.css';

document.body.className = darkTwClass;
document.body.style.cssText = 'margin:0;background:#0b1018;color:#dde5ef;font:13px system-ui';
const dates: number[] = [];
for (let date = Date.UTC(2026, 5, 1) / 1000; date <= Date.UTC(2026, 9, 2) / 1000; date += 86400) {
    if (![0, 6].includes(new Date(date * 1000).getUTCDay())) dates.push(date);
}
const dayLabels = dates.slice(-61);
function candles(state: number): Candle[] {
    const result = dayLabels.map((time, i) => {
        let close = i % 2 ? 101 : 100, volume = 100;
        if (state === 0 && i === 60) { close = 104; volume = 200; }
        if ((state === 1 || state === 2) && i === 59) { close = 104; volume = 200; }
        if (state === 1 && i === 60) { close = 105; volume = 100; }
        if (state === 2 && i === 60) { close = 99; volume = 0; }
        if (state === 3 && i === 60) { close = 111; volume = 300; }
        const open = i >= 59 ? 101 : close;
        return { time, open, close, high: Math.max(open, close) + .25, low: Math.min(open, close) - .25, volume };
    });
    return state === 5 ? result.slice(-10) : result;
}
const names = [['3363', '光環'], ['3455', '由田'], ['4991', '環宇-KY'], ['4919', '新唐'], ['3042', '晶技'], ['2327', '國巨']];
const rows = names.map(([code, name], i) => ({
    contract: { code, name: `${name}（合成示例）`, security_type: 'STK', region: 'TW', exchange: 'TSE', target_code: null } as ContractInfo,
    daily: candles(i),
}));
function Fixture() {
    const [width, setWidth] = useState<number | undefined>();
    const [count, setCount] = useState(6);
    const [empty, setEmpty] = useState(false);
    const [picked, setPicked] = useState('—');
    const fixtureRows = empty ? rows.map(row => ({ ...row, daily: candles(4) })) : count === 40
        ? Array.from({ length: 40 }, (_, i) => ({ contract: { ...rows[i % 6]!.contract, code: String(6000 + i), name: `合成研究股${i + 1}` }, daily: candles(i % 6) })) : rows;
    return <main style={{ width: '100%', boxSizing: 'border-box', padding: 10 }}>
        <header style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', marginBottom: 8 }}>
            <strong>離線合成資料驗收，不是六檔實際行情</strong>
            <button onClick={() => setWidth(undefined)}>寬版</button>
            <button onClick={() => setWidth(320)}>窄320px</button>
            <button onClick={() => setCount(count === 6 ? 40 : 6)}>{count === 6 ? '40檔' : '6檔'}</button>
            <button onClick={() => setEmpty(!empty)}>{empty ? '混合狀態' : '空候選'}</button>
            <span>已點選 {picked}</span>
        </header>
        <section style={{ width: width ?? '100%', maxWidth: '100%', height: 'calc(100vh - 75px)', minHeight: 420, border: '1px solid #334052', background: '#141922', boxSizing: 'border-box' }}>
            <ResearchDailyBreakoutPanel rows={fixtureRows} loading={false} error={null} onPick={setPicked} />
        </section>
    </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
