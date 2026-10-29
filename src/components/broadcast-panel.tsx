// src/components/broadcast-panel.tsx — 語音播報面板（全域設定中心）。
//
// 這是「語音播報」功能的設定入口，**全 app 只有一個**（singleton）：
//   - 全域設定：總開關 / 三類事件的開關 / 語速 / 冷卻 / 語音
//   - 行情類要播報哪些商品（存在 block 上，隨版面存檔）
//   - 最近播報紀錄（方便確認真的有在念）
//
// 為什麼是 singleton：事件來源（成交、條件單、通知）是**全域**的，
// 多個面板各有一份設定會互相衝突——哪一份生效？規則會變得不可預期。
//
// 設計取自 WpfApp6 的 MonitorTab：有自己的商品清單與播報開關，
// 全域共用同一個語音引擎與去重表。

import { Volume2, VolumeX, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useContract } from '../lib/contracts-cache';
import { useQuote } from '../hooks/use-stream';
import {
    broadcastUrgent,
    clearBroadcastQuoteCodes,
    setBroadcastQuoteCodes,
    useBroadcastLog,
} from '../lib/broadcast/broadcast-hub';
import {
    COOLDOWN_MAX,
    COOLDOWN_MIN,
    RATE_MAX,
    RATE_MIN,
    setBroadcastSettings,
    useBroadcastSettings,
} from '../lib/broadcast/broadcast-settings';
import {
    searchProducts,
    type ProductSuggestion,
} from '../lib/product-search';
import { getTtsEngine } from '../lib/tts';
import type { TtsProbe } from '../lib/tts';
import { fmtPrice } from '../lib/utils/format';
import * as styles from './broadcast-panel.css';

function clockOf(at: number) {
    const d = new Date(at);
    return `${String(d.getHours()).padStart(2, '0')}:${String(
        d.getMinutes(),
    ).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

export interface BroadcastPanelProps {
    /** 行情類要播報的商品代碼（隨版面存檔） */
    codes: string[];
    onCodesChange: (codes: string[]) => void;
}

/** 三類事件：名稱 / 說明 / 設定欄位 */
const EVENT_ROWS = [
    {
        key: 'quoteEnabled' as const,
        label: '行情狀態',
        hint: '創新高／破新低／漲跌停（需在下方指定商品）',
    },
    {
        key: 'dealEnabled' as const,
        label: '成交／委託',
        hint: '委託成功、成交、撤單、改價、委託失敗',
    },
    {
        key: 'noticeEnabled' as const,
        label: '通知／條件單',
        hint: '條件單觸發、委託待確認、收盤平倉提醒',
    },
];

export function BroadcastPanel({ codes, onCodesChange }: BroadcastPanelProps) {
    const settings = useBroadcastSettings();
    const log = useBroadcastLog();
    const engine = getTtsEngine();
    const [input, setInput] = useState('');
    const [suggestions, setSuggestions] = useState<ProductSuggestion[]>([]);
    const [probe, setProbe] = useState<TtsProbe | null>(null);

    // 引擎的「實際能不能用」是非同步才知道的（原生引擎要看模型在不在），
    // 所以面板要先問一次 probe() 再顯示狀態，不能只信同步的 available。
    useEffect(() => {
        let active = true;
        void engine.probe().then((result) => {
            if (active) setProbe(result);
        });
        return () => {
            active = false;
        };
    }, [engine]);

    // 把行情播報清單給中樞（面板關閉時清掉）
    // 用「代號內容」當依賴而不是陣列參考值：block.broadcastCodes 沒設定時
    // `?? []` 每次 render 都是新參考值，會讓 effect 每個 render 重跑一次，
    // 造成訂閱被取消又重新訂閱（多打 API）。
    const codesKey = codes.join('|');
    useEffect(() => {
        setBroadcastQuoteCodes(codesKey ? codesKey.split('|') : []);
        return () => clearBroadcastQuoteCodes();
    }, [codesKey]);

    // 搜尋建議（沿用自選清單的 debounce 寫法）
    useEffect(() => {
        const query = input.trim();
        if (!query) {
            setSuggestions([]);
            return;
        }
        let active = true;
        const timer = setTimeout(() => {
            void searchProducts(query, 8)
                .then((results) => {
                    if (active) setSuggestions(results);
                })
                .catch(() => {
                    if (active) setSuggestions([]);
                });
        }, 250);
        return () => {
            active = false;
            clearTimeout(timer);
        };
    }, [input]);

    const addCode = useCallback(
        (code: string) => {
            const normalized = code.trim().toUpperCase();
            if (!normalized) return;
            if (codes.includes(normalized)) {
                setInput('');
                setSuggestions([]);
                return;
            }
            onCodesChange([...codes, normalized]);
            setInput('');
            setSuggestions([]);
        },
        [codes, onCodesChange],
    );

    const removeCode = useCallback(
        (code: string) => {
            onCodesChange(codes.filter((c) => c !== code));
        },
        [codes, onCodesChange],
    );

    const voices = useMemo(() => engine.listVoices(), [engine]);
    // 只有一種語音時不顯示選擇器（單一音色是刻意的設計，選了也沒得選）
    const showVoicePicker = voices.length > 1;

    const usable = probe ? probe.available : engine.available;
    const unusableReason = probe?.reason ?? engine.reason;

    return (
        <div className={styles.wrap}>
            <div className={styles.header}>
                <span className={styles.title}>語音播報</span>
                <span
                    className={usable ? styles.badge.ok : styles.badge.bad}
                    title={unusableReason}
                >
                    {probe === null
                        ? '檢查中…'
                        : usable
                          ? '語音可用'
                          : '語音不可用'}
                </span>
                <span className={styles.spacer} />
                <button
                    className={
                        settings.enabled
                            ? `${styles.toggle} ${styles.toggleOn}`
                            : `${styles.toggle} ${styles.toggleOff}`
                    }
                    onClick={() =>
                        setBroadcastSettings({ enabled: !settings.enabled })
                    }
                >
                    {settings.enabled ? '播報中' : '已關閉'}
                </button>
            </div>

            <div className={styles.scroller}>
                {!usable && unusableReason && (
                    <span className={styles.notice}>{unusableReason}</span>
                )}

                <span className={styles.sectionTitle}>播報事件</span>
                <div className={styles.switchList}>
                    {EVENT_ROWS.map((row) => (
                        <label className={styles.switchRow} key={row.key}>
                            <input
                                type='checkbox'
                                checked={settings[row.key]}
                                onChange={(e) =>
                                    setBroadcastSettings({
                                        [row.key]: e.target.checked,
                                    })
                                }
                            />
                            <span className={styles.switchLabel}>
                                {row.label}
                            </span>
                            <span className={styles.switchHint}>{row.hint}</span>
                        </label>
                    ))}
                </div>

                <span className={styles.sectionTitle}>播報設定</span>
                <div className={styles.settingsGrid}>
                    <span className={styles.settingLabel}>語速</span>
                    <input
                        className={styles.slider}
                        type='range'
                        min={RATE_MIN}
                        max={RATE_MAX}
                        step={1}
                        value={settings.rate}
                        onChange={(e) =>
                            setBroadcastSettings({ rate: Number(e.target.value) })
                        }
                    />
                    <span className={styles.settingValue}>{settings.rate}</span>

                    <span className={styles.settingLabel}>冷卻</span>
                    <input
                        className={styles.slider}
                        type='range'
                        min={COOLDOWN_MIN}
                        max={COOLDOWN_MAX}
                        step={1}
                        value={settings.cooldownSec}
                        onChange={(e) =>
                            setBroadcastSettings({
                                cooldownSec: Number(e.target.value),
                            })
                        }
                    />
                    <span className={styles.settingValue}>
                        {settings.cooldownSec} 秒
                    </span>

                    {showVoicePicker && (
                        <select
                            className={styles.select}
                            value={settings.voiceUri}
                            onChange={(e) =>
                                setBroadcastSettings({ voiceUri: e.target.value })
                            }
                        >
                            <option value=''>語音：自動挑選中文語音</option>
                            {voices.map((v) => (
                                <option key={v.uri} value={v.uri}>
                                    語音：{v.name}（{v.lang}）
                                </option>
                            ))}
                        </select>
                    )}
                </div>

                <span className={styles.sectionTitle}>
                    播報商品（{codes.length}）
                </span>
                {codes.length === 0 && (
                    <span className={styles.empty}>
                        尚未指定商品。加入商品後，該商品創新高／破新低／漲跌停時會語音播報。
                    </span>
                )}
                {codes.map((code) => (
                    <TargetRow
                        key={code}
                        code={code}
                        onRemove={() => removeCode(code)}
                    />
                ))}

                <div className={styles.addRow}>
                    {suggestions.length > 0 && (
                        <div className={styles.suggestBox}>
                            {suggestions.map((s) => (
                                <button
                                    key={`${s.security_type}:${s.code}`}
                                    className={styles.suggestRow}
                                    onClick={() => addCode(s.code)}
                                >
                                    <span className={styles.suggestCode}>
                                        {s.code}
                                    </span>
                                    <span className={styles.suggestName}>
                                        {s.name}
                                    </span>
                                    <span className={styles.suggestCat}>
                                        {s.detail}
                                    </span>
                                </button>
                            ))}
                        </div>
                    )}
                    <input
                        className={styles.addInput}
                        placeholder='加入商品（如 台積電、TX期）'
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                                setSuggestions([]);
                                addCode(input);
                            }
                            if (e.key === 'Escape') setSuggestions([]);
                        }}
                    />
                </div>

                <span className={styles.sectionTitle}>最近播報</span>
                {log.length === 0 && (
                    <span className={styles.empty}>還沒有播報紀錄。</span>
                )}
                {log.slice(0, 8).map((entry) => (
                    <div
                        className={styles.logRow}
                        key={`${entry.code}-${entry.at}`}
                    >
                        <span className={styles.logTime}>
                            {clockOf(entry.at)}
                        </span>
                        <span className={styles.logText}>{entry.text}</span>
                    </div>
                ))}

                <div className={styles.addRow}>
                    <button
                        className={`${styles.toggle} ${styles.toggleOff}`}
                        onClick={() =>
                            broadcastUrgent(
                                `語音測試，目前語速 ${settings.rate}`,
                            )
                        }
                    >
                        {settings.enabled ? (
                            <Volume2 size={12} />
                        ) : (
                            <VolumeX size={12} />
                        )}{' '}
                        測試語音
                    </button>
                </div>
            </div>
        </div>
    );
}

function TargetRow({
    code,
    onRemove,
}: {
    code: string;
    onRemove: () => void;
}) {
    const contract = useContract(code);
    const quote = useQuote(code);
    const close = quote?.tick?.close ?? quote?.index?.close;
    return (
        <div className={styles.targetRow}>
            <span className={styles.code}>{code}</span>
            <span className={styles.name}>
                {contract?.name ?? '解析中…'}
            </span>
            <span className={styles.price}>
                {close !== undefined ? fmtPrice(Number(close)) : '—'}
            </span>
            <button
                className={styles.removeBtn}
                title='移除'
                onClick={onRemove}
            >
                <X size={11} />
            </button>
        </div>
    );
}
