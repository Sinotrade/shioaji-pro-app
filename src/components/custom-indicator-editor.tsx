// src/components/custom-indicator-editor.tsx — in-app editor for
// user-written indicators（JS + ta.* 函式庫）。儲存前先在 Web Worker
// 驗證（2 秒逾時擋無窮迴圈）並自動偵測 plot()/hline() 的輸出。

import { HelpCircle, Plus, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useEscClose } from '../hooks/use-esc-close';
import {
    CUSTOM_PALETTE,
    deleteCustom,
    newCustomId,
    saveCustom,
    validateCustom,
    type CustomIndicator,
} from '../lib/custom-indicators';
import type { OutputDef, ParamDef } from '../lib/indicator-defs';
import * as dlg from './indicator-dialog.css';
import { COLOR_GRID } from './indicator-dialog';
import * as styles from './custom-indicator-editor.css';

const KIND_LABEL: Record<OutputDef['kind'], string> = {
    line: '線',
    dashed: '虛線',
    histogram: '柱狀',
    points: '圓點',
};

const DEFAULT_SOURCE = `// 範例：雙 EMA 動能震盪（改成你自己的邏輯）
const fast = ta.ema(close, p.fast)
const slow = ta.ema(close, p.slow)
plot('動能', ta.sub(fast, slow), { kind: 'histogram', signed: true })
hline(0)
`;

const DEFAULT_PARAMS: ParamDef[] = [
    { key: 'fast', label: '快線週期', def: 12, min: 1, max: 500 },
    { key: 'slow', label: '慢線週期', def: 26, min: 1, max: 500 },
];

const HELP = [
    ['內建序列', 'open high low close volume time hl2 hlc3 ohlc4（陣列，與 K 棒逐根對齊）'],
    ['參數', 'p.參數名 — 在上方「參數」表定義，加入後可在指標設定裡調'],
    ['輸出', "plot('名稱', 序列, { kind:'line|dashed|histogram|points', color:'#rrggbb', signed:true, width:2 })"],
    ['水平線', 'hline(數值) — 副圖的參考水平線（如 RSI 的 30/70）'],
    ['均線', 'ta.sma(src,n)  ta.ema(src,n)  ta.wma(src,n)  ta.rma(src,n)'],
    ['統計', 'ta.stdev(src,n)  ta.highest(src,n)  ta.lowest(src,n)  ta.sum(src,n)'],
    ['動能', 'ta.change(src,n)  ta.roc(src,n)  ta.rsi(src,n)'],
    ['波幅', 'ta.tr(high,low,close)  ta.atr(high,low,close,n)'],
    ['運算', 'ta.add / sub / mul / div / max / min / avg(a,b) — 序列或常數混用'],
    ['其他', 'ta.abs(src)  ta.offset(src,n) 取 n 期前值  ta.cum(src) 累積和'],
    ['交叉', 'ta.crossover(a,b)  ta.crossunder(a,b) — 交叉那根 = 1，其餘 0'],
    ['缺值', '暖身期以 null 表示，圖上自動留白斷線'],
] as const;

const KEY_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export function CustomIndicatorEditor({
    existing,
    onClose,
}: {
    existing: CustomIndicator | null;
    onClose: () => void;
}) {
    const [name, setName] = useState(existing?.name ?? '');
    const [short, setShort] = useState(existing?.short ?? '');
    const [desc, setDesc] = useState(existing?.desc ?? '');
    const [category, setCategory] = useState<'overlay' | 'pane'>(
        existing?.category ?? 'pane',
    );
    const [params, setParams] = useState<ParamDef[]>(
        existing?.params ?? DEFAULT_PARAMS,
    );
    const [source, setSource] = useState(existing?.source ?? DEFAULT_SOURCE);
    const [outputs, setOutputs] = useState<OutputDef[]>(
        existing?.outputs ?? [],
    );
    const [levels, setLevels] = useState<number[]>(existing?.levels ?? []);
    const [error, setError] = useState<string | null>(null);
    const [validating, setValidating] = useState(false);
    const [helpOpen, setHelpOpen] = useState(false);
    const [colorFor, setColorFor] = useState<string | null>(null);
    // 通過驗證的 source — 改碼後要重新驗證才能存
    const [validatedFor, setValidatedFor] = useState<string | null>(
        existing ? existing.source : null,
    );
    const busyRef = useRef(false);

    useEscClose(onClose);

    const paramDefaults = (list: ParamDef[]) => {
        const p: Record<string, number> = {};
        for (const d of list) p[d.key] = d.def;
        return p;
    };

    const paramsError = (): string | null => {
        const seen = new Set<string>();
        for (const d of params) {
            if (!KEY_RE.test(d.key)) {
                return `參數代號「${d.key || '(空白)'}」要用英文/數字/底線，且不能以數字開頭`;
            }
            if (seen.has(d.key)) return `參數代號「${d.key}」重複了`;
            seen.add(d.key);
        }
        return null;
    };

    // 驗證 + 偵測輸出；回傳是否通過（儲存流程會接著用）
    const validate = async (): Promise<boolean> => {
        const pe = paramsError();
        if (pe) {
            setError(pe);
            return false;
        }
        setValidating(true);
        setError(null);
        const res = await validateCustom(source, paramDefaults(params));
        setValidating(false);
        if (res.error) {
            setError(res.error);
            setValidatedFor(null);
            return false;
        }
        // 使用者在下方微調過的樣式優先；plot() 的 opts 當初始預設
        setOutputs((prev) =>
            res.order.map((key, i) => {
                const kept = prev.find((o) => o.key === key);
                const hint = res.hints[key] ?? {};
                return {
                    key,
                    label: kept?.label ?? key,
                    kind: kept?.kind ?? hint.kind ?? 'line',
                    color:
                        kept?.color ??
                        (hint.color && /^#[0-9a-fA-F]{6}$/.test(hint.color)
                            ? hint.color
                            : CUSTOM_PALETTE[i % CUSTOM_PALETTE.length]!),
                    ...(kept?.signed ?? hint.signed ? { signed: true } : {}),
                    ...((kept?.width ?? hint.width)
                        ? { width: (kept?.width ?? hint.width) as 1 | 2 }
                        : {}),
                };
            }),
        );
        setLevels([...new Set(res.levels)]);
        setValidatedFor(source);
        return true;
    };

    const save = async () => {
        if (busyRef.current) return;
        busyRef.current = true;
        try {
            if (!name.trim()) {
                setError('幫指標取個名稱');
                return;
            }
            if (validatedFor !== source) {
                const ok = await validate();
                if (!ok) return;
            }
            // validate() 的 setOutputs 是非同步 state — 存檔用最新偵測結果
            const res = await validateCustom(source, paramDefaults(params));
            if (res.error) {
                setError(res.error);
                return;
            }
            const outs: OutputDef[] = res.order.map((key, i) => {
                const kept = outputs.find((o) => o.key === key);
                const hint = res.hints[key] ?? {};
                return {
                    key,
                    label: kept?.label ?? key,
                    kind: kept?.kind ?? hint.kind ?? 'line',
                    color:
                        kept?.color ??
                        (hint.color && /^#[0-9a-fA-F]{6}$/.test(hint.color)
                            ? hint.color
                            : CUSTOM_PALETTE[i % CUSTOM_PALETTE.length]!),
                    ...(kept?.signed ?? hint.signed ? { signed: true } : {}),
                    ...((kept?.width ?? hint.width)
                        ? { width: (kept?.width ?? hint.width) as 1 | 2 }
                        : {}),
                };
            });
            saveCustom({
                id: existing?.id ?? newCustomId(),
                name: name.trim(),
                short: short.trim() || name.trim(),
                desc: desc.trim(),
                category,
                params,
                outputs: outs,
                levels: [...new Set(res.levels)],
                source,
                updatedAt: Date.now(),
            });
            onClose();
        } finally {
            busyRef.current = false;
        }
    };

    const patchParam = (i: number, patch: Partial<ParamDef>) => {
        setParams((list) =>
            list.map((d, j) => (j === i ? { ...d, ...patch } : d)),
        );
    };

    const patchOutput = (key: string, patch: Partial<OutputDef>) => {
        setOutputs((list) =>
            list.map((o) => (o.key === key ? { ...o, ...patch } : o)),
        );
    };

    return (
        <div className={styles.overlay}>
            <div className={styles.dialog}>
                <div className={dlg.header}>
                    {existing ? `編輯自訂指標 — ${existing.name}` : '建立自訂指標'}
                    <button className={dlg.closeBtn} onClick={onClose}>
                        <X size={16} />
                    </button>
                </div>
                <div className={styles.body}>
                    <div className={styles.metaRow}>
                        <label className={styles.field} style={{ flex: 2 }}>
                            <span className={styles.fieldLabel}>名稱</span>
                            <input
                                className={styles.textInput}
                                value={name}
                                placeholder='例：我的動能指標'
                                onChange={(e) => setName(e.target.value)}
                            />
                        </label>
                        <label className={styles.field} style={{ flex: 1 }}>
                            <span className={styles.fieldLabel}>
                                縮寫（legend）
                            </span>
                            <input
                                className={styles.textInput}
                                value={short}
                                placeholder='例：MOM'
                                onChange={(e) => setShort(e.target.value)}
                            />
                        </label>
                        <div className={styles.field}>
                            <span className={styles.fieldLabel}>位置</span>
                            <div className={styles.catBtnRow}>
                                <button
                                    className={
                                        styles.catBtn[
                                            category === 'overlay'
                                                ? 'active'
                                                : 'normal'
                                        ]
                                    }
                                    onClick={() => setCategory('overlay')}
                                >
                                    主圖疊加
                                </button>
                                <button
                                    className={
                                        styles.catBtn[
                                            category === 'pane'
                                                ? 'active'
                                                : 'normal'
                                        ]
                                    }
                                    onClick={() => setCategory('pane')}
                                >
                                    副圖
                                </button>
                            </div>
                        </div>
                    </div>
                    <label className={styles.field}>
                        <span className={styles.fieldLabel}>說明（選填）</span>
                        <input
                            className={styles.textInput}
                            value={desc}
                            placeholder='一句話描述這個指標在看什麼'
                            onChange={(e) => setDesc(e.target.value)}
                        />
                    </label>

                    <div className={styles.sectionTitle}>
                        <span>參數（程式碼裡用 p.代號 取值）</span>
                        <button
                            className={styles.smallBtn}
                            onClick={() =>
                                setParams((l) => [
                                    ...l,
                                    {
                                        key: `p${l.length + 1}`,
                                        label: '',
                                        def: 14,
                                        min: 1,
                                        max: 500,
                                    },
                                ])
                            }
                        >
                            <Plus size={12} /> 加參數
                        </button>
                    </div>
                    {params.length > 0 && (
                        <div className={styles.paramHead}>
                            <span>代號</span>
                            <span>顯示名稱</span>
                            <span>預設</span>
                            <span>最小</span>
                            <span>最大</span>
                            <span>間距</span>
                            <span />
                        </div>
                    )}
                    {params.map((d, i) => (
                        <div key={i} className={styles.paramRow}>
                            <input
                                className={styles.monoInput}
                                value={d.key}
                                spellCheck={false}
                                onChange={(e) =>
                                    patchParam(i, { key: e.target.value })
                                }
                            />
                            <input
                                className={styles.textInput}
                                value={d.label}
                                placeholder={d.key}
                                onChange={(e) =>
                                    patchParam(i, { label: e.target.value })
                                }
                            />
                            {(['def', 'min', 'max'] as const).map((f) => (
                                <input
                                    key={f}
                                    type='number'
                                    className={styles.monoInput}
                                    value={d[f]}
                                    onChange={(e) => {
                                        const v = Number(e.target.value);
                                        if (Number.isFinite(v)) {
                                            patchParam(i, { [f]: v });
                                        }
                                    }}
                                />
                            ))}
                            <input
                                type='number'
                                className={styles.monoInput}
                                value={d.step ?? 1}
                                onChange={(e) => {
                                    const v = Number(e.target.value);
                                    if (Number.isFinite(v) && v > 0) {
                                        patchParam(i, { step: v });
                                    }
                                }}
                            />
                            <button
                                className={styles.iconBtn}
                                title='移除參數'
                                onClick={() =>
                                    setParams((l) =>
                                        l.filter((_, j) => j !== i),
                                    )
                                }
                            >
                                <Trash2 size={13} />
                            </button>
                        </div>
                    ))}

                    <div className={styles.sectionTitle}>
                        <span>程式碼（JavaScript + ta 函式庫）</span>
                        <button
                            className={styles.smallBtn}
                            onClick={() => setHelpOpen((o) => !o)}
                        >
                            <HelpCircle size={12} />{' '}
                            {helpOpen ? '收起說明' : '語法說明'}
                        </button>
                    </div>
                    {helpOpen && (
                        <div className={styles.helpBox}>
                            {HELP.map(([k, v]) => (
                                <div key={k}>
                                    <span className={styles.helpKey}>
                                        {k}
                                    </span>
                                    ：{v}
                                </div>
                            ))}
                        </div>
                    )}
                    <textarea
                        className={styles.codeArea}
                        value={source}
                        spellCheck={false}
                        onChange={(e) => setSource(e.target.value)}
                        onKeyDown={(e) => {
                            // Tab 縮排不跳焦點
                            if (e.key === 'Tab') {
                                e.preventDefault();
                                const el = e.currentTarget;
                                const s = el.selectionStart;
                                const t = el.selectionEnd;
                                const next = `${source.slice(0, s)}    ${source.slice(t)}`;
                                setSource(next);
                                requestAnimationFrame(() => {
                                    el.selectionStart = el.selectionEnd =
                                        s + 4;
                                });
                            }
                        }}
                    />

                    {error && <div className={styles.errorBox}>{error}</div>}
                    {!error && validatedFor === source && outputs.length > 0 && (
                        <>
                            <div className={styles.okNote}>
                                驗證通過 — 偵測到 {outputs.length} 條輸出
                                {levels.length > 0 &&
                                    `、水平線 ${levels.join(' / ')}`}
                            </div>
                            {outputs.map((o) => (
                                <div key={o.key}>
                                    <div className={styles.outputRow}>
                                        <button
                                            className={styles.swatchBtn}
                                            style={{ background: o.color }}
                                            title='顏色'
                                            onClick={() =>
                                                setColorFor(
                                                    colorFor === o.key
                                                        ? null
                                                        : o.key,
                                                )
                                            }
                                        />
                                        <span
                                            className={styles.fieldLabel}
                                            style={{ alignSelf: 'center' }}
                                        >
                                            plot('{o.key}')
                                        </span>
                                        <input
                                            className={styles.textInput}
                                            value={o.label}
                                            placeholder='顯示名稱'
                                            onChange={(e) =>
                                                patchOutput(o.key, {
                                                    label: e.target.value,
                                                })
                                            }
                                        />
                                        <select
                                            className={styles.select}
                                            value={o.kind}
                                            onChange={(e) =>
                                                patchOutput(o.key, {
                                                    kind: e.target
                                                        .value as OutputDef['kind'],
                                                })
                                            }
                                        >
                                            {(
                                                Object.keys(
                                                    KIND_LABEL,
                                                ) as OutputDef['kind'][]
                                            ).map((k) => (
                                                <option key={k} value={k}>
                                                    {KIND_LABEL[k]}
                                                </option>
                                            ))}
                                        </select>
                                    </div>
                                    {colorFor === o.key && (
                                        <div className={styles.swatchPop}>
                                            {COLOR_GRID.flat().map((c) => (
                                                <button
                                                    key={c}
                                                    className={styles.swatch}
                                                    style={{ background: c }}
                                                    onClick={() => {
                                                        patchOutput(o.key, {
                                                            color: c,
                                                        });
                                                        setColorFor(null);
                                                    }}
                                                />
                                            ))}
                                            <input
                                                className={styles.hexInput}
                                                value={o.color}
                                                spellCheck={false}
                                                onChange={(e) => {
                                                    const v =
                                                        e.target.value.trim();
                                                    if (
                                                        /^#[0-9a-fA-F]{6}$/.test(
                                                            v,
                                                        )
                                                    ) {
                                                        patchOutput(o.key, {
                                                            color: v,
                                                        });
                                                    }
                                                }}
                                            />
                                        </div>
                                    )}
                                </div>
                            ))}
                        </>
                    )}
                </div>
                <div className={styles.footer}>
                    <div>
                        {existing && (
                            <button
                                className={dlg.dangerBtn}
                                onClick={() => {
                                    deleteCustom(existing.id);
                                    onClose();
                                }}
                            >
                                刪除指標
                            </button>
                        )}
                    </div>
                    <div className={styles.footerActions}>
                        <button className={dlg.cancelBtn} onClick={onClose}>
                            取消
                        </button>
                        <button
                            className={dlg.cancelBtn}
                            disabled={validating}
                            onClick={() => void validate()}
                        >
                            {validating ? '驗證中…' : '驗證'}
                        </button>
                        <button
                            className={dlg.okBtn}
                            disabled={validating}
                            onClick={() => void save()}
                        >
                            儲存
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
