// src/components/scanner-panel.tsx — market movers leaderboard

import { useEffect, useMemo, useState } from 'react';
import { focusSector } from '../lib/sector-sync';
import { logKgiDebug } from '../lib/kgi-debug';
import { fetchScanner } from '../lib/kgi';
import { normalizeScannerItem } from '../lib/quote-model';
import {
    categoryOf,
    loadStockDetails,
    sectorLabel,
    type StockMeta,
} from '../lib/stock-index';
import type { ScannerItem, ScannerType } from '../lib/types/market';
import { fmtInt, fmtPct, fmtPrice } from '../lib/utils/format';
import * as panel from './panel.css';
import * as styles from './scanner-panel.css';

// NOTE: the bridge's `ascending` flag keeps the historical frontend contract:
// true -> largest first. Encode the working values per mode here.
const MODES: { key: string; type: ScannerType; label: string; ascending: boolean }[] = [
    { key: 'gain', type: 'ChangePercentRank', label: '漲幅', ascending: true },
    { key: 'loss', type: 'ChangePercentRank', label: '跌幅', ascending: false },
    { key: 'vol', type: 'VolumeRank', label: '量', ascending: true },
    { key: 'amt', type: 'AmountRank', label: '額', ascending: true },
    { key: 'multi', type: 'ChangePercentRank', label: '複選', ascending: true },
];

// 複選 (issue #2): union three deep ranks, then intersect by thresholds —
// the top names are often untradeable, crossing conditions finds the rest.
// `short` flips the 漲幅 condition to 跌幅 so you can screen short candidates
// (跌幅 + 量 + 額), which the long-only version couldn't surface.
async function fetchMulti(
    minPct: number,
    minVolK: number,
    minAmtB: number,
    short: boolean,
): Promise<ScannerItem[]> {
    const [pct, vol, amt] = await Promise.allSettled([
        fetchScanner('ChangePercentRank', 100, !short),
        fetchScanner('VolumeRank', 100, true),
        fetchScanner('AmountRank', 100, true),
    ]);
    const byCode = new Map<string, ScannerItem>();
    for (const r of [pct, vol, amt]) {
        if (r.status !== 'fulfilled') continue;
        for (const it of r.value) {
            if (!byCode.has(it.code)) byCode.set(it.code, it);
        }
    }
    const out = [...byCode.values()].filter((it) => {
        const pctV = normalizeScannerItem(it).changePercent ?? 0;
        const pctOk = short ? pctV <= -minPct : pctV >= minPct;
        return (
            pctOk &&
            it.total_volume >= minVolK * 1000 &&
            it.total_amount >= minAmtB * 1e8
        );
    });
    out.sort((a, b) => {
        const pa = normalizeScannerItem(a).changePercent ?? 0;
        const pb = normalizeScannerItem(b).changePercent ?? 0;
        return short ? pa - pb : pb - pa; // 放空：跌最多在前
    });
    return out.slice(0, 30);
}

const MODE_KEY = 'sj-pro-scanner-mode';
const REFRESH_MS = 15000;

// 額 in 億 for readability
function fmtAmount(amount: number): string {
    if (!Number.isFinite(amount) || amount <= 0) return '';
    return `${(amount / 1e8).toFixed(1)}億`;
}

export function ScannerPanel({
    onPick,
}: {
    onPick: (code: string) => void;
}) {
    const [modeKey, setModeKey] = useState(
        () => localStorage.getItem(MODE_KEY) ?? 'gain',
    );
    const [items, setItems] = useState<ScannerItem[]>([]);
    const [error, setError] = useState('');
    const [reloadSeq, setReloadSeq] = useState(0);
    const [picked, setPicked] = useState<string | null>(null);
    // 複選 thresholds (persisted)
    const [minPct, setMinPct] = useState(
        () => Number(localStorage.getItem('sj-scan-minpct')) || 2,
    );
    const [minVolK, setMinVolK] = useState(
        () => Number(localStorage.getItem('sj-scan-minvol')) || 5,
    );
    const [minAmtB, setMinAmtB] = useState(
        () => Number(localStorage.getItem('sj-scan-minamt')) || 1,
    );
    const [multiShort, setMultiShort] = useState(
        () => localStorage.getItem('sj-scan-multishort') === '1',
    );
    const [index, setIndex] = useState<StockMeta[] | null>(null);
    const mode = MODES.find((m) => m.key === modeKey) ?? MODES[0]!;

    // Contract V2: fetch typed StockInfo only for the visible scanner rows.
    useEffect(() => {
        let alive = true;
        loadStockDetails(items.map((item) => item.code))
            .then((details) => {
                if (alive) setIndex(details);
            })
            .catch(() => undefined);
        return () => {
            alive = false;
        };
    }, [items]);
    const catByCode = useMemo(() => {
        const m = new Map<string, string>();
        for (const it of items) {
            const c = index ? categoryOf(index, it.code) : null;
            if (c) m.set(it.code, c);
        }
        return m;
    }, [items, index]);

    useEffect(() => {
        let cancelled = false;
        setError('');
        const load = () =>
            (mode.key === 'multi'
                ? fetchMulti(minPct, minVolK, minAmtB, multiShort)
                : fetchScanner(mode.type, 20, mode.ascending)
            )
                .then((d) => {
                    if (cancelled) return;
                    logKgiDebug('[ranking raw]', d);
                    setItems(d);
                    setError('');
                })
                .catch((err: unknown) => {
                    if (cancelled) return;
                    const message =
                        err instanceof Error ? err.message : String(err);
                    setError(
                        message.includes('此帳戶無排行資料權限') ||
                            message.includes('D403')
                            ? '此帳戶無排行資料權限'
                            : '排行資料無法取得',
                    );
                });
        load();
        const t = setInterval(load, REFRESH_MS);
        return () => {
            cancelled = true;
            clearInterval(t);
        };
    }, [mode, reloadSeq, minPct, minVolK, minAmtB, multiShort]);

    return (
        <>
            <div className={styles.switcher}>
                {MODES.map((m) => (
                    <button
                        key={m.key}
                        className={styles.sw[modeKey === m.key ? 'on' : 'off']}
                        onClick={() => {
                            setModeKey(m.key);
                            localStorage.setItem(MODE_KEY, m.key);
                        }}
                    >
                        {m.label}
                    </button>
                ))}
            </div>
            {mode.key === 'multi' && (
                <div className={styles.filterRow}>
                    <div className={styles.switcher} style={{ padding: 0 }}>
                        {(
                            [
                                ['做多', false],
                                ['放空', true],
                            ] as [string, boolean][]
                        ).map(([label, sh]) => (
                            <button
                                key={label}
                                className={
                                    styles.sw[multiShort === sh ? 'on' : 'off']
                                }
                                onClick={() => {
                                    setMultiShort(sh);
                                    localStorage.setItem(
                                        'sj-scan-multishort',
                                        sh ? '1' : '0',
                                    );
                                }}
                            >
                                {label}
                            </button>
                        ))}
                    </div>
                    {(
                        [
                            [
                                multiShort ? '跌幅≥%' : '漲幅≥%',
                                minPct,
                                setMinPct,
                                'sj-scan-minpct',
                            ],
                            ['量≥千張', minVolK, setMinVolK, 'sj-scan-minvol'],
                            ['額≥億', minAmtB, setMinAmtB, 'sj-scan-minamt'],
                        ] as [string, number, (v: number) => void, string][]
                    ).map(([label, value, set, key]) => (
                        <label key={key} className={styles.filterItem}>
                            {label}
                            <input
                                className={styles.filterInput}
                                value={value}
                                inputMode='decimal'
                                onChange={(e) => {
                                    const v = Number(e.target.value);
                                    if (Number.isFinite(v) && v >= 0) {
                                        set(v);
                                        localStorage.setItem(key, String(v));
                                    }
                                }}
                            />
                        </label>
                    ))}
                </div>
            )}
            <div className={panel.panelBody}>
                {error && (
                    <div className={styles.errorBox}>
                        <span className={styles.scName}>{error}</span>
                        <button
                            className={styles.retryBtn}
                            onClick={() => setReloadSeq((s) => s + 1)}
                        >
                            重試
                        </button>
                    </div>
                )}
                {items.map((it, i) => {
                    const normalized = normalizeScannerItem(it);
                    const dir = normalized.direction;
                    const pct = normalized.changePercent;
                    const sub =
                        mode.key === 'amt'
                            ? fmtAmount(it.total_amount)
                            : it.total_volume > 0
                              ? fmtInt(it.total_volume)
                              : '';
                    return (
                        <div
                            key={it.code}
                            className={`${styles.row} ${
                                picked === it.code ? styles.rowPicked : ''
                            }`}
                            onClick={() => {
                                setPicked(it.code);
                                onPick(it.code);
                            }}
                        >
                            <span className={styles.rank}>
                                {String(i + 1).padStart(2, '0')}
                            </span>
                            <span className={styles.idBlock}>
                                <span className={styles.scCode}>
                                    {it.code}
                                </span>
                                <span className={styles.scName}>
                                    {it.name}
                                </span>
                            </span>
                            {catByCode.get(it.code) ? (
                                <button
                                    className={styles.sectorTag}
                                    title='跳到此類股熱力圖'
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        focusSector(catByCode.get(it.code)!);
                                    }}
                                >
                                    {sectorLabel(catByCode.get(it.code)!)}
                                </button>
                            ) : (
                                <span />
                            )}
                            <span className={styles.valueBlock}>
                                <span
                                    className={`${styles.scValue} ${panel.dirText[dir]}`}
                                >
                                    {fmtPrice(it.close)} {fmtPct(pct)}
                                </span>
                                <span className={styles.scSub}>{sub}</span>
                            </span>
                        </div>
                    );
                })}
            </div>
        </>
    );
}

