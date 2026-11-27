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
// 面板持有自己的商品清單與播報開關，但全域共用同一個語音引擎與去重表：
// 設定集中在一處，去重與佇列才能跨商品、跨面板正確運作。

import { Volume2, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useContract } from '../lib/contracts-cache';
import { useQuote } from '../hooks/use-stream';
import {
    broadcastUrgent,
    clearBroadcastQuoteCodes,
    setBroadcastQuoteCodes,
    syncBroadcastDebugSwitches,
    useBroadcastLog,
} from '../lib/broadcast/broadcast-hub';
import {
    downloadBroadcastTrace,
    dumpBroadcastDebug,
    getBroadcastTrace,
    isBroadcastTraceEnabled,
    setBroadcastTraceEnabled,
    useBroadcastDebug,
} from '../lib/broadcast/broadcast-debug';
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
import type { TtsProbe, TtsVoice } from '../lib/tts';
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
    const debug = useBroadcastDebug();
    const engine = getTtsEngine();
    const [input, setInput] = useState('');
    // trace 開關：預設關（診斷用）。狀態放在元件裡是為了讓按鈕立刻反映，
    // 真正的記錄判斷在 broadcast-debug 的 pushTrace()。
    const [traceOn, setTraceOn] = useState(isBroadcastTraceEnabled());
    // 兩個分頁：日常調設定、查問題才進診斷（診斷資訊不再佔用設定頁的版面）
    const [tab, setTab] = useState<'settings' | 'diag'>('settings');
    // 每一輪 render 讀一次長度即可：面板本身會隨 debug 快照更新而重繪
    const traceCount = getBroadcastTrace().length;
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

    // 把開關的實際值同步到除錯面板（沒有 tick 時也要看得到）
    useEffect(() => {
        syncBroadcastDebugSwitches();
    }, [
        settings.enabled,
        settings.quoteEnabled,
        settings.dealEnabled,
        settings.noticeEnabled,
    ]);

    // 把行情播報清單給中樞（面板關閉時清掉）
    // 用「代號內容」當依賴而不是陣列參考值：block.broadcastCodes 沒設定時
    // `?? []` 每次 render 都是新參考值，會讓 effect 每個 render 重跑一次，
    // 造成訂閱被取消又重新訂閱（多打 API）。
    const codesKey = codes.join('|');
    useEffect(() => {
        setBroadcastQuoteCodes(codesKey ? codesKey.split('|') : []);
    }, [codesKey]);

    // 「清空」只能在面板卸載時做。若把它當成上面那個 effect 的 cleanup，
    // 每次新增／移除商品都會先清空再重設 → 所有商品被退訂重訂，
    // 播報狀態（高低點基準、冷卻計時、訂閱中的 tick 計數）全部歸零，
    // 等於「加第二個商品時，第一個商品的狀態被偷偷重置」。
    useEffect(() => () => clearBroadcastQuoteCodes(), []);

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

    // 語音清單在 Chromium（含桌面版 WebView2）首次取用時是空的，之後才透過
    // voiceschanged 事件補上；因此不能只讀一次就固定，必須訂閱後續更新，
    // 否則「語音選擇」在桌面版永遠不會出現。
    const [voices, setVoices] = useState<TtsVoice[]>(() => engine.listVoices());
    useEffect(
        () =>
            engine.subscribeVoices?.((list) => {
                setVoices(list);
            }),
        [engine],
    );
    // 只有一種語音時不顯示選擇器（單一音色是刻意的設計，選了也沒得選）
    const showVoicePicker = voices.length > 1;

    // 已訂閱卻收不到即時報價的商品（最常見原因：當下不是該商品的交易時段）
    const noQuoteTargets = Object.values(debug.targets).filter(
        (t) => t.noQuote,
    );

    const usable = probe ? probe.available : engine.available;
    const unusableReason = probe?.reason ?? engine.reason;

    const tabBtn = (key: 'settings' | 'diag', label: string, badge?: number) => (
        <button
            type='button'
            role='tab'
            aria-selected={tab === key}
            className={tab === key ? `${styles.tab} ${styles.tabActive}` : styles.tab}
            onClick={() => setTab(key)}
        >
            {label}
            {badge !== undefined && (
                <span className={styles.tabBadge}>{badge}</span>
            )}
        </button>
    );

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

            <div className={styles.tabs} role='tablist'>
                {tabBtn('settings', '設定')}
                {tabBtn('diag', '診斷', debug.counters.ticks)}
            </div>

            {tab === 'settings' ? (
                <div className={styles.pane} role='tabpanel' aria-label='設定'>
                    {/* 所有可調項集中在同一張卡：事件類別 / 語速 / 冷卻 / 語音 / 測試語音 */}
                    <div className={styles.card}>
                        <span className={styles.cardHead}>播報控制</span>

                        {!usable && unusableReason && (
                            <span className={styles.notice}>{unusableReason}</span>
                        )}
                        {!settings.enabled && (
                            <span className={styles.warn}>
                                語音播報目前是關閉的 —— 打開右上角的開關才會播報。
                                （「測試語音」不受這個開關影響，所以測試有聲不代表播報有開。）
                            </span>
                        )}
                        {settings.enabled &&
                            !settings.quoteEnabled &&
                            !settings.dealEnabled &&
                            !settings.noticeEnabled && (
                                <span className={styles.warn}>
                                    總開關已開，但三種事件都沒勾 —— 勾選想聽的那一種。
                                </span>
                            )}

                        <div className={styles.chips}>
                            {EVENT_ROWS.map((row) => (
                                <button
                                    key={row.key}
                                    type='button'
                                    title={row.hint}
                                    aria-pressed={settings[row.key]}
                                    className={
                                        settings[row.key]
                                            ? `${styles.chip} ${styles.chipOn}`
                                            : styles.chip
                                    }
                                    onClick={() =>
                                        setBroadcastSettings({
                                            [row.key]: !settings[row.key],
                                        })
                                    }
                                >
                                    <span
                                        className={
                                            settings[row.key]
                                                ? `${styles.chipDot} ${styles.chipDotOn}`
                                                : styles.chipDot
                                        }
                                    />
                                    {row.label}
                                </button>
                            ))}
                        </div>
                        <span className={styles.chipHint}>
                            {EVENT_ROWS.filter((row) => settings[row.key])
                                .map((row) => row.hint)
                                .join('　') || '尚未勾選任何事件類別'}
                        </span>

                        <div className={styles.knobRow}>
                            <span className={styles.knobLabel}>語速</span>
                            <input
                                className={styles.slider}
                                type='range'
                                min={RATE_MIN}
                                max={RATE_MAX}
                                step={1}
                                value={settings.rate}
                                onChange={(e) =>
                                    setBroadcastSettings({
                                        rate: Number(e.target.value),
                                    })
                                }
                            />
                            <span className={styles.knobVal}>
                                {settings.rate}
                            </span>
                        </div>

                        <div className={styles.knobRow}>
                            <span className={styles.knobLabel}>冷卻</span>
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
                            <span className={styles.knobVal}>
                                {settings.cooldownSec} 秒
                            </span>
                        </div>

                        {showVoicePicker && (
                            <div className={styles.voiceRow}>
                                <span className={styles.knobLabel}>語音</span>
                                <select
                                    className={styles.select}
                                    value={settings.voiceUri}
                                    onChange={(e) =>
                                        setBroadcastSettings({
                                            voiceUri: e.target.value,
                                        })
                                    }
                                >
                                    <option value=''>自動挑選中文語音</option>
                                    {voices.map((v) => (
                                        <option key={v.uri} value={v.uri}>
                                            {v.name}（{v.lang}）
                                        </option>
                                    ))}
                                </select>
                            </div>
                        )}

                        <button
                            type='button'
                            className={styles.testBtn}
                            title='不受總開關影響：這裡驗的是「發聲管道」，不是播報規則'
                            onClick={() =>
                                broadcastUrgent(
                                    `語音測試，目前語速 ${settings.rate}`,
                                )
                            }
                        >
                            <Volume2 size={12} /> 測試語音（不受總開關限制）
                        </button>
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

                    {noQuoteTargets.length > 0 && (
                        <span className={styles.warn}>
                            ⚠ 有 {noQuoteTargets.length} 個商品（{noQuoteTargets
                                .map((t) => t.code)
                                .join('、')}）已訂閱但沒有即時報價 ——
                            可能是這些商品當下沒有成交，或不在交易時段（台股盤中
                            09:00–13:30、盤後定價 14:00–14:30；期貨另有夜盤）。
                        </span>
                    )}

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
                            placeholder='加入商品(如:2330、CDFR1)'
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
                </div>
            ) : (
                <div className={styles.pane} role='tabpanel' aria-label='診斷'>
                    <span className={styles.sectionTitle}>開關與佇列</span>
                    <div className={styles.debugGrid}>
                        <span className={styles.debugKey}>開關</span>
                        <span className={styles.debugVal}>
                            總={debug.switches.enabled ? '開' : '關'} · 行情=
                            {debug.switches.quote ? '開' : '關'} · 成交=
                            {debug.switches.deal ? '開' : '關'} · 通知=
                            {debug.switches.notice ? '開' : '關'}
                        </span>

                        <span className={styles.debugKey}>佇列</span>
                        <span className={styles.debugVal}>
                            待播 {debug.queue.pending} ·{' '}
                            {debug.queue.speakingText
                                ? `正在念「${debug.queue.speakingText}」`
                                : '閒置'}
                        </span>
                    </div>

                    <span className={styles.sectionTitle}>計數</span>
                    <div className={styles.counterGrid}>
                        {[
                            { k: 'TICK', v: debug.counters.ticks },
                            { k: '判定', v: debug.counters.decisions },
                            { k: '已播', v: debug.counters.spoke },
                            { k: '一般報價', v: debug.counters.generalQuotes },
                            { k: '冷卻擋', v: debug.counters.blockedCooldown },
                            { k: '去重擋', v: debug.counters.duplicateSuppressed },
                            { k: '過時丟棄', v: debug.counters.droppedStale },
                            { k: '待播佇列', v: debug.queue.pending },
                        ].map((c) => (
                            <div className={styles.counterCell} key={c.k}>
                                <span className={styles.counterKey}>{c.k}</span>
                                <span className={styles.counterVal}>{c.v}</span>
                            </div>
                        ))}
                    </div>

                    <span className={styles.sectionTitle}>商品狀態</span>
                    {Object.keys(debug.targets).length === 0 && (
                        <span className={styles.empty}>
                            尚未加入要播報的商品。
                        </span>
                    )}
                    {Object.values(debug.targets).map((t) => (
                        <div className={styles.debugTarget} key={t.code}>
                            <span className={styles.debugTargetCode}>
                                {t.code}
                            </span>
                            <span className={styles.debugTargetName}>
                                {t.name}
                            </span>
                            <span className={styles.debugTargetDetail}>
                                合約=
                                {t.contractResolved
                                    ? 'OK'
                                    : `失敗${t.contractError ? `(${t.contractError})` : ''}`}{' '}
                                · 訂閱={t.subscribedTypes.join('/') || '無'} ·
                                tick={t.tickCount} · 價={t.lastPrice ?? '—'} ·
                                判定={t.lastStatus ?? '—'} · 未播=
                                {t.lastSkipReason ?? '—'} · 已播=
                                {t.lastSpokeText ?? '—'}
                            </span>
                            {t.noQuote && (
                                <span className={styles.debugWarn}>
                                    ⚠ {t.noQuoteReason}
                                </span>
                            )}
                        </div>
                    ))}

                    <span className={styles.sectionTitle}>時間軸紀錄</span>
                    <div className={styles.addRow}>
                        <button
                            className={`${styles.toggle} ${
                                traceOn ? styles.toggleOn : styles.toggleOff
                            }`}
                            onClick={() => {
                                const next = !traceOn;
                                setBroadcastTraceEnabled(next);
                                setTraceOn(next);
                            }}
                            title='診斷用。平常關掉即可；要查「為什麼沒聲音」時再打開來記錄時間軸。'
                        >
                            {traceOn ? '記錄 trace：開' : '記錄 trace：關'}
                        </button>
                        <button
                            className={`${styles.toggle} ${styles.toggleOff}`}
                            onClick={() => dumpBroadcastDebug()}
                        >
                            診斷（丟到 console）
                        </button>
                        <button
                            className={`${styles.toggle} ${styles.toggleOff}`}
                            disabled={traceCount === 0}
                            onClick={() => downloadBroadcastTrace()}
                            title='下載這段時間的時間軸與目前狀態（純文字，可直接貼給別人看）'
                        >
                            匯出 trace.txt
                        </button>
                    </div>
                    <span className={styles.diagNote}>
                        trace 只在需要查「為什麼沒聲音」時打開；平常關閉不產生任何記錄成本。
                    </span>
                </div>
            )}
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
