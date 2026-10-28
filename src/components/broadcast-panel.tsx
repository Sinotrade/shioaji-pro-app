// src/components/broadcast-panel.tsx — 語音播報面板。
//
// 這是「語音播報」功能的設定入口：
//   - 上半段：全域設定（總開關 / 語速 / 冷卻 / 語音）
//   - 中段：這個面板要播報哪些商品（每個面板各有一份，隨版面存檔）
//   - 下段：最近播報紀錄（方便確認真的有在念）
//
// 設計取自 WpfApp6 的 MonitorTab：每個監控頁有自己的商品清單與播報開關，
// 全域共用同一個語音引擎與去重表。

import { Volume2, VolumeX, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useContract } from '../lib/contracts-cache';
import { useQuote } from '../hooks/use-stream';
import {
    broadcastUrgent,
    registerBroadcastPanel,
    unregisterBroadcastPanel,
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
import { fmtPrice } from '../lib/utils/format';
import * as styles from './broadcast-panel.css';

function clockOf(at: number) {
    const d = new Date(at);
    return `${String(d.getHours()).padStart(2, '0')}:${String(
        d.getMinutes(),
    ).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

export interface BroadcastPanelProps {
    /** 所屬面板 id —— 用來在中樞註冊這份播報清單 */
    blockId: string;
    /** 這個面板要播報的商品代碼 */
    codes: string[];
    onCodesChange: (codes: string[]) => void;
}

export function BroadcastPanel({
    blockId,
    codes,
    onCodesChange,
}: BroadcastPanelProps) {
    const settings = useBroadcastSettings();
    const log = useBroadcastLog();
    const engine = getTtsEngine();
    const [input, setInput] = useState('');
    const [suggestions, setSuggestions] = useState<ProductSuggestion[]>([]);

    // 把這個面板的播報清單註冊到中樞（面板關閉時自動取消）
    // 用「代號內容」當依賴而不是陣列參考值：block.broadcastCodes 沒設定時
    // `?? []` 每次 render 都是新參考值，會讓 effect 每個 render 重跑一次，
    // 造成訂閱被取消又重新訂閱（多打 API）。
    const codesKey = codes.join('|');
    useEffect(() => {
        registerBroadcastPanel(
            blockId,
            codesKey ? codesKey.split('|') : [],
        );
        return () => unregisterBroadcastPanel(blockId);
    }, [blockId, codesKey]);

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

    return (
        <div className={styles.wrap}>
            <div className={styles.header}>
                <span className={styles.title}>語音播報</span>
                <span
                    className={
                        engine.available ? styles.badge.ok : styles.badge.bad
                    }
                >
                    {engine.available ? '語音可用' : '語音不可用'}
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
                {!engine.available && (
                    <span className={styles.notice}>
                        {engine.reason ?? '此環境無法使用語音播報'}
                    </span>
                )}

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
