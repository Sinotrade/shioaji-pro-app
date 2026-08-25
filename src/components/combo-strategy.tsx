// src/components/combo-strategy.tsx — 選擇權策略快建（issue #32 追加）
//
// 專業建倉動線：選商品/月份 → 選策略 → 選履約價（預設貼 ATM）→
// 兩腳自動帶入組合單（canonical 順序＋策略型別意圖）。不用讀代碼、
// 不用手打兩腳，垂直價差/跨式/勒式/轉逆/跨月都是三兩下完成。

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuote } from '../hooks/use-stream';
import {
    fetchOptionRoots,
    fetchOptions,
    type ComboType,
    type ContractRoot,
} from '../lib/shioaji';
import * as styles from './order-ticket.css';
import * as css from './combo-ticket.css';
import * as dx from './derivative-explorer.css';
import { Orb } from './orb';

interface OptLite {
    code: string;
    month: string;
    strike: number;
    call: boolean;
}

const rootCache = new Map<string, OptLite[]>();
const rootLoading = new Map<string, Promise<OptLite[]>>();

async function loadOptRoot(root: string): Promise<OptLite[]> {
    const cached = rootCache.get(root);
    if (cached) return cached;
    const inflight = rootLoading.get(root);
    if (inflight) return inflight;
    const p = (async () => {
        const rows = await fetchOptions(root);
        const lite = rows
            .filter(
                (c) =>
                    c.security_type === 'OPT' &&
                    typeof c.delivery_month === 'string' &&
                    typeof c.strike_price === 'number' &&
                    typeof c.option_right === 'string',
            )
            .map((c) => ({
                code: c.code,
                month: c.delivery_month as string,
                strike: c.strike_price as number,
                call: (c.option_right as string).toUpperCase().startsWith('C'),
            }));
        rootCache.set(root, lite);
        rootLoading.delete(root);
        return lite;
    })();
    rootLoading.set(root, p);
    return p;
}

type Strategy = 'vertical' | 'straddle' | 'strangle' | 'convrev' | 'calendar';

const STRATEGY_LABEL: Record<Strategy, string> = {
    vertical: '價差',
    straddle: '跨式',
    strangle: '勒式',
    convrev: '轉逆',
    calendar: '跨月',
};

const SB_ROOT_KEY = 'sj-pro-combo-sb-root';

export function OptionStrategyBuilder({
    onBuild,
}: {
    // codes 已是 canonical 腳序；intended 為曖昧型別（跨式/轉逆）的明確意圖
    onBuild: (codes: [string, string], intended: ComboType | null) => void;
}) {
    const [roots, setRoots] = useState<ContractRoot[]>([]);
    const [root, setRoot] = useState(
        () => localStorage.getItem(SB_ROOT_KEY) || 'TXO',
    );
    const [contracts, setContracts] = useState<OptLite[] | null>(null);
    const [month, setMonth] = useState('');
    const [strategy, setStrategy] = useState<Strategy>('vertical');
    const [right, setRight] = useState<'C' | 'P'>('C');
    const [k1, setK1] = useState<number | null>(null); // 主/低履約
    const [k2, setK2] = useState<number | null>(null); // 第二/高履約
    const [farMonth, setFarMonth] = useState('');

    useEffect(() => {
        fetchOptionRoots()
            .then(setRoots)
            .catch(() => undefined);
    }, []);

    useEffect(() => {
        let stale = false;
        setContracts(null);
        loadOptRoot(root)
            .then((rows) => {
                if (!stale) setContracts(rows);
            })
            .catch(() => {
                if (!stale) setContracts([]);
            });
        return () => {
            stale = true;
        };
    }, [root]);

    const months = useMemo(
        () =>
            [...new Set((contracts ?? []).map((c) => c.month))]
                .filter(Boolean)
                .sort()
                .slice(0, 6),
        [contracts],
    );
    useEffect(() => {
        setMonth((m) => (m && months.includes(m) ? m : (months[0] ?? '')));
    }, [months]);

    // 台指家族用 TXFR1 當 ATM 參考；其他 root 退回履約價中位數
    const txf = useQuote('TXFR1');
    const atm =
        txf?.tick && /^TX/.test(root) ? Number(txf.tick.close) : null;

    const strikes = useMemo(() => {
        const inMonth = (contracts ?? []).filter((c) => c.month === month);
        return [...new Set(inMonth.map((c) => c.strike))].sort(
            (a, b) => a - b,
        );
    }, [contracts, month]);

    const nearestIdx = useMemo(() => {
        if (strikes.length === 0) return -1;
        const center = atm ?? strikes[Math.floor(strikes.length / 2)]!;
        let idx = 0;
        let best = Infinity;
        strikes.forEach((s, i) => {
            const d = Math.abs(s - center);
            if (d < best) {
                best = d;
                idx = i;
            }
        });
        return idx;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [strikes, atm === null ? 0 : Math.round(atm / 50)]);

    // 月份/策略/商品切換 → 履約價預設貼 ATM（價差/勒式第二腳取上一
    // 檔）。ATM 隨行情漂移「不」重設 — 開著面板時 TXF 跨 50 點就把
    // 使用者手選的履約蓋掉、還連帶重帶兩腳，是實盤陷阱（QA10）。
    // nearestIdx 由 ref 讀當下值，不進 deps。
    const nearestIdxRef = useRef(nearestIdx);
    nearestIdxRef.current = nearestIdx;
    useEffect(() => {
        const idx = nearestIdxRef.current;
        if (idx < 0) {
            setK1(null);
            setK2(null);
            return;
        }
        setK1(strikes[idx] ?? null);
        setK2(strikes[Math.min(idx + 1, strikes.length - 1)] ?? null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [root, month, strategy, strikes.length === 0]);

    useEffect(() => {
        const later = months.filter((m) => m > month);
        setFarMonth((f) =>
            f && later.includes(f) ? f : (later[0] ?? ''),
        );
    }, [months, month]);

    const find = (m: string, strike: number, call: boolean) =>
        (contracts ?? []).find(
            (c) => c.month === m && c.strike === strike && c.call === call,
        )?.code ?? null;

    // 目前選擇 → canonical 兩腳＋意圖型別
    const plan = useMemo((): {
        codes: [string, string];
        intended: ComboType | null;
    } | null => {
        if (!month || k1 === null) return null;
        if (strategy === 'vertical') {
            if (k2 === null || k1 === k2) return null;
            const lo = Math.min(k1, k2);
            const hi = Math.max(k1, k2);
            const isCall = right === 'C';
            // canonical：Call [高,低]、Put [低,高]
            const first = find(month, isCall ? hi : lo, isCall);
            const second = find(month, isCall ? lo : hi, isCall);
            return first && second
                ? { codes: [first, second], intended: null }
                : null;
        }
        if (strategy === 'straddle' || strategy === 'convrev') {
            const call = find(month, k1, true);
            const put = find(month, k1, false);
            return call && put
                ? {
                      codes: [call, put],
                      intended:
                          strategy === 'straddle'
                              ? 'Straddle'
                              : 'ConversionReversal',
                  }
                : null;
        }
        if (strategy === 'strangle') {
            if (k2 === null || k1 === k2) return null;
            // 慣例：買低 Put＋高 Call；canonical [Call, Put]
            const call = find(month, Math.max(k1, k2), true);
            const put = find(month, Math.min(k1, k2), false);
            return call && put ? { codes: [call, put], intended: null } : null;
        }
        // calendar 跨月：同履約同權利，近月在前
        if (!farMonth || farMonth === month) return null;
        const near = find(month, k1, right === 'C');
        const far = find(farMonth, k1, right === 'C');
        return near && far ? { codes: [near, far], intended: null } : null;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [contracts, month, farMonth, strategy, right, k1, k2]);

    // 選擇完整就帶入（300ms debounce — 連續切履約不狂打 API）。
    // key 含意圖型別 — 跨式↔轉逆兩腳代碼相同，只換意圖也要重帶
    const planKey = plan
        ? `${plan.codes.join('|')}:${plan.intended ?? ''}`
        : '';
    useEffect(() => {
        if (!plan) return;
        const t = setTimeout(() => onBuild(plan.codes, plan.intended), 300);
        return () => clearTimeout(t);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [planKey]);

    const needK2 = strategy === 'vertical' || strategy === 'strangle';
    const needRight = strategy === 'vertical' || strategy === 'calendar';
    const strikeSelect = (
        value: number | null,
        onChange: (v: number) => void,
        label: string,
    ) => (
        <select
            className={dx.select}
            aria-label={label}
            value={value ?? ''}
            onChange={(e) => onChange(Number(e.target.value))}
        >
            {strikes.map((s) => (
                <option key={s} value={s}>
                    {s}
                    {nearestIdx >= 0 && strikes[nearestIdx] === s
                        ? '（ATM）'
                        : ''}
                </option>
            ))}
        </select>
    );

    return (
        <div className={css.section}>
            <div className={styles.fieldRow}>
                <span className={styles.fieldLabel}>商品</span>
                <select
                    className={dx.select}
                    value={root}
                    onChange={(e) => {
                        setRoot(e.target.value);
                        localStorage.setItem(SB_ROOT_KEY, e.target.value);
                    }}
                >
                    {!roots.some((r) => r.root === root) && (
                        <option value={root}>{root}</option>
                    )}
                    {roots.map((r) => (
                        <option key={r.root} value={r.root}>
                            {r.name.replace(/\s*\d{6}$/, '')}（{r.root}）
                        </option>
                    ))}
                </select>
                <select
                    className={dx.select}
                    aria-label='月份'
                    value={month}
                    onChange={(e) => setMonth(e.target.value)}
                >
                    {months.map((m) => (
                        <option key={m} value={m}>
                            {m.slice(0, 4)}/{m.slice(4)}
                        </option>
                    ))}
                </select>
            </div>
            <div className={styles.fieldRow}>
                <span className={styles.fieldLabel}>策略</span>
                <div className={styles.segGroup}>
                    {(Object.keys(STRATEGY_LABEL) as Strategy[]).map((s) => (
                        <button
                            key={s}
                            className={styles.seg[strategy === s ? 'on' : 'off']}
                            title={
                                s === 'vertical'
                                    ? '垂直價差：同月同權利、不同履約'
                                    : s === 'straddle'
                                      ? '跨式：同履約 Call＋Put 同向'
                                      : s === 'strangle'
                                        ? '勒式：不同履約 Call＋Put 同向'
                                        : s === 'convrev'
                                          ? '轉換/逆轉：同履約 Call、Put 反向'
                                          : '時間價差：同履約同權利、跨月'
                            }
                            onClick={() => setStrategy(s)}
                        >
                            {STRATEGY_LABEL[s]}
                        </button>
                    ))}
                </div>
            </div>
            <div className={styles.fieldRow}>
                {needRight && (
                    <div className={styles.segGroup} style={{ flex: '0 0 auto' }}>
                        {(['C', 'P'] as const).map((r) => (
                            <button
                                key={r}
                                className={styles.seg[right === r ? 'on' : 'off']}
                                onClick={() => setRight(r)}
                            >
                                {r === 'C' ? 'Call' : 'Put'}
                            </button>
                        ))}
                    </div>
                )}
                {contracts === null ? (
                    <span className={styles.costRow}>
                        <Orb size={11} style={{ marginRight: 4, verticalAlign: '-2px' }} />
                        載入 {root} 合約…
                    </span>
                ) : strikes.length === 0 ? (
                    <span className={styles.costRow}>此月份沒有合約</span>
                ) : (
                    <>
                        {strikeSelect(k1, setK1, '履約價')}
                        {needK2 && strikeSelect(k2, (v) => setK2(v), '第二履約價')}
                        {strategy === 'calendar' && (
                            <select
                                className={dx.select}
                                aria-label='遠月'
                                value={farMonth}
                                onChange={(e) => setFarMonth(e.target.value)}
                            >
                                {months
                                    .filter((m) => m > month)
                                    .map((m) => (
                                        <option key={m} value={m}>
                                            遠 {m.slice(0, 4)}/{m.slice(4)}
                                        </option>
                                    ))}
                            </select>
                        )}
                    </>
                )}
            </div>
        </div>
    );
}
