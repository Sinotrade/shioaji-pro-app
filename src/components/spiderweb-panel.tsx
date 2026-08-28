// src/components/spiderweb-panel.tsx — spider-web (蛛網) strategy panel.
// Multi-level grid where each entry fill automatically arms a reverse exit.
// Client-side only — strategies run while app is open, stop when closed.

import { AlertTriangle, Play, Square, Trash2, Edit2, Save, X } from 'lucide-react';
import { useState } from 'react';
import { useQuote } from '../hooks/use-stream';
import {
    type SpiderwebStrategy,
    type StepMode,
    armStrategy,
    createStrategy,
    deleteStrategy,
    disarmStrategy,
    updateStrategy,
    useStrategies,
} from '../lib/spiderweb-engine';
import type { ContractInfo } from '../lib/types/contract';
import { fmtPrice } from '../lib/utils/format';
import * as styles from './order-ticket.css';
import * as flash from './flash-order.css';
import * as panel from './panel.css';

const STEP_MODE_LABELS: Record<StepMode, string> = {
    percent: '漲幅 %',
    ticks: '檔數',
    points: '固定價差',
};

export function SpiderwebPanel({ contract }: { contract: ContractInfo }) {
    const quote = useQuote(contract.code);
    const strategies = useStrategies();
    const [tab, setTab] = useState<'form' | 'list'>('list');
    const [editingId, setEditingId] = useState<string | null>(null);

    // form state
    const [name, setName] = useState('');
    const [side, setSide] = useState<'Buy' | 'Sell'>('Buy');
    const [startPrice, setStartPrice] = useState('');
    const [stepMode, setStepMode] = useState<StepMode>('percent');
    const [stepValue, setStepValue] = useState('1.7');
    const [numLevels, setNumLevels] = useState(5);
    const [qtyPerLevel, setQtyPerLevel] = useState(1);

    // edit state
    const [editName, setEditName] = useState('');
    const [editStartPrice, setEditStartPrice] = useState('');
    const [editStepValue, setEditStepValue] = useState('');
    const [editNumLevels, setEditNumLevels] = useState(5);
    const [editQtyPerLevel, setEditQtyPerLevel] = useState(1);

    const last = quote?.tick ? Number(quote.tick.close) : contract.reference || null;

    const myStrategies = strategies.filter((s) => s.code === contract.code);

    const handleCreate = () => {
        const start = Number(startPrice) || last || 0;
        if (start <= 0) return;
        const step = Number(stepValue);
        if (step <= 0) return;

        createStrategy({
            name: name.trim() || `${side === 'Buy' ? '多方' : '空方'}蛛網`,
            enabled: false,
            code: contract.code,
            security_type: contract.security_type as string,
            side,
            startPrice: start,
            stepMode,
            stepValue: step,
            numLevels,
            qtyPerLevel,
        });

        // Reset form
        setName('');
        setStartPrice('');
        setTab('list');
    };

    const handleStartEdit = (s: SpiderwebStrategy) => {
        setEditingId(s.id);
        setEditName(s.name);
        setEditStartPrice(s.startPrice.toString());
        setEditStepValue(s.stepValue.toString());
        setEditNumLevels(s.numLevels);
        setEditQtyPerLevel(s.qtyPerLevel);
    };

    const handleSaveEdit = (s: SpiderwebStrategy) => {
        const start = Number(editStartPrice);
        const step = Number(editStepValue);

        if (start > 0 && step > 0) {
            updateStrategy(s.id, {
                name: editName.trim() || s.name,
                startPrice: start,
                stepValue: step,
                numLevels: editNumLevels,
                qtyPerLevel: editQtyPerLevel,
            });
        }
        setEditingId(null);
    };

    const handleCancelEdit = () => {
        setEditingId(null);
    };

    const handleArm = (id: string) => void armStrategy(id);
    const handleDisarm = (id: string) => void disarmStrategy(id);
    const handleDelete = (id: string) => {
        if (confirm('確定刪除此策略？')) {
            deleteStrategy(id);
        }
    };

    const totalInventory = (s: SpiderwebStrategy): number => {
        return s.levels.reduce((sum, lv) => sum + (lv.state === 'held' || lv.state === 'exit-working' ? lv.entryFillQty : 0), 0);
    };

    const totalPnL = (s: SpiderwebStrategy): number => {
        return s.levels.reduce((sum, lv) => {
            if (lv.exitFillQty === 0) return sum;
            const pnl = (lv.exitAvgPrice - lv.entryAvgPrice) * (s.side === 'Buy' ? 1 : -1) * lv.exitFillQty;
            return sum + pnl;
        }, 0);
    };

    return (
        <div className={styles.body}>
            <div style={{ padding: '8px', borderBottom: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
                    <button
                        className={flash.armBtn[tab === 'list' ? 'on' : 'off']}
                        onClick={() => setTab('list')}
                        style={{ flex: 1 }}
                    >
                        策略列表
                    </button>
                    <button
                        className={flash.armBtn[tab === 'form' ? 'on' : 'off']}
                        onClick={() => setTab('form')}
                        style={{ flex: 1 }}
                    >
                        新增策略
                    </button>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--text-muted)' }}>
                    <AlertTriangle size={12} />
                    <span>蛛網策略為 client 端運行，App 關閉即停止</span>
                </div>
            </div>

            {tab === 'form' && (
                <div style={{ padding: '12px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                    <div className={styles.fieldRow}>
                        <span className={styles.fieldLabel}>策略名稱</span>
                        <input
                            className={styles.numInput}
                            value={name}
                            placeholder={`${side === 'Buy' ? '多方' : '空方'}蛛網`}
                            onChange={(e) => setName(e.target.value)}
                            style={{ flex: 1 }}
                        />
                    </div>

                    <div className={styles.sideTabs}>
                        <button
                            className={styles.buyTab[side === 'Buy' ? 'on' : 'off']}
                            onClick={() => setSide('Buy')}
                        >
                            多方蛛網
                        </button>
                        <button
                            className={styles.sellTab[side === 'Sell' ? 'on' : 'off']}
                            onClick={() => setSide('Sell')}
                        >
                            空方蛛網
                        </button>
                    </div>

                    <div className={styles.fieldRow}>
                        <span className={styles.fieldLabel}>起始價</span>
                        <input
                            className={styles.numInput}
                            value={startPrice}
                            placeholder={last?.toFixed(2) || ''}
                            inputMode='decimal'
                            onChange={(e) => setStartPrice(e.target.value)}
                            style={{ flex: 1 }}
                        />
                    </div>

                    <div className={styles.fieldRow}>
                        <span className={styles.fieldLabel}>間距模式</span>
                        <select
                            className={styles.numInput}
                            value={stepMode}
                            onChange={(e) => setStepMode(e.target.value as StepMode)}
                            style={{ flex: 1 }}
                        >
                            {Object.entries(STEP_MODE_LABELS).map(([k, label]) => (
                                <option key={k} value={k}>
                                    {label}
                                </option>
                            ))}
                        </select>
                    </div>

                    <div className={styles.fieldRow}>
                        <span className={styles.fieldLabel}>
                            {stepMode === 'percent' ? '漲幅 %' : stepMode === 'ticks' ? '檔距' : '價差'}
                        </span>
                        <input
                            className={styles.numInput}
                            value={stepValue}
                            inputMode='decimal'
                            onChange={(e) => setStepValue(e.target.value)}
                            style={{ flex: 1 }}
                        />
                    </div>

                    <div className={styles.fieldRow}>
                        <span className={styles.fieldLabel}>檔數</span>
                        <button
                            className={styles.stepBtn}
                            onClick={() => setNumLevels(Math.max(1, numLevels - 1))}
                        >
                            −
                        </button>
                        <input
                            className={styles.numInput}
                            value={numLevels}
                            inputMode='numeric'
                            onChange={(e) => {
                                const v = Number(e.target.value);
                                if (Number.isInteger(v) && v >= 1 && v <= 20) setNumLevels(v);
                            }}
                        />
                        <button
                            className={styles.stepBtn}
                            onClick={() => setNumLevels(Math.min(20, numLevels + 1))}
                        >
                            ＋
                        </button>
                    </div>

                    <div className={styles.fieldRow}>
                        <span className={styles.fieldLabel}>每檔量</span>
                        <button
                            className={styles.stepBtn}
                            onClick={() => setQtyPerLevel(Math.max(1, qtyPerLevel - 1))}
                        >
                            −
                        </button>
                        <input
                            className={styles.numInput}
                            value={qtyPerLevel}
                            inputMode='numeric'
                            onChange={(e) => {
                                const v = Number(e.target.value);
                                if (Number.isInteger(v) && v >= 1 && v <= 99) setQtyPerLevel(v);
                            }}
                        />
                        <button
                            className={styles.stepBtn}
                            onClick={() => setQtyPerLevel(Math.min(99, qtyPerLevel + 1))}
                        >
                            ＋
                        </button>
                    </div>

                    <button
                        className={styles.execBtn[side === 'Buy' ? 'buy' : 'sell']}
                        onClick={handleCreate}
                    >
                        建立策略
                    </button>
                </div>
            )}

            {tab === 'list' && (
                <div style={{ padding: '8px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {myStrategies.length === 0 && (
                        <div style={{ padding: '20px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '12px' }}>
                            尚無策略，點選「新增策略」開始
                        </div>
                    )}

                    {myStrategies.map((s) => (
                        <div
                            key={s.id}
                            style={{
                                border: '1px solid var(--border)',
                                borderRadius: '6px',
                                padding: '10px',
                                backgroundColor: s.enabled ? 'var(--surface-hover)' : 'transparent',
                            }}
                        >
                            {editingId === s.id ? (
                                // Edit mode
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                                    <div className={styles.fieldRow}>
                                        <span className={styles.fieldLabel}>名稱</span>
                                        <input
                                            className={styles.numInput}
                                            value={editName}
                                            onChange={(e) => setEditName(e.target.value)}
                                            style={{ flex: 1 }}
                                        />
                                    </div>
                                    <div className={styles.fieldRow}>
                                        <span className={styles.fieldLabel}>起始價</span>
                                        <input
                                            className={styles.numInput}
                                            value={editStartPrice}
                                            inputMode='decimal'
                                            onChange={(e) => setEditStartPrice(e.target.value)}
                                            style={{ flex: 1 }}
                                        />
                                    </div>
                                    <div className={styles.fieldRow}>
                                        <span className={styles.fieldLabel}>間距值</span>
                                        <input
                                            className={styles.numInput}
                                            value={editStepValue}
                                            inputMode='decimal'
                                            onChange={(e) => setEditStepValue(e.target.value)}
                                            style={{ flex: 1 }}
                                        />
                                    </div>
                                    <div className={styles.fieldRow}>
                                        <span className={styles.fieldLabel}>檔數</span>
                                        <button className={styles.stepBtn} onClick={() => setEditNumLevels(Math.max(1, editNumLevels - 1))}>−</button>
                                        <input
                                            className={styles.numInput}
                                            value={editNumLevels}
                                            inputMode='numeric'
                                            onChange={(e) => {
                                                const v = Number(e.target.value);
                                                if (Number.isInteger(v) && v >= 1 && v <= 20) setEditNumLevels(v);
                                            }}
                                        />
                                        <button className={styles.stepBtn} onClick={() => setEditNumLevels(Math.min(20, editNumLevels + 1))}>＋</button>
                                    </div>
                                    <div className={styles.fieldRow}>
                                        <span className={styles.fieldLabel}>每檔量</span>
                                        <button className={styles.stepBtn} onClick={() => setEditQtyPerLevel(Math.max(1, editQtyPerLevel - 1))}>−</button>
                                        <input
                                            className={styles.numInput}
                                            value={editQtyPerLevel}
                                            inputMode='numeric'
                                            onChange={(e) => {
                                                const v = Number(e.target.value);
                                                if (Number.isInteger(v) && v >= 1 && v <= 99) setEditQtyPerLevel(v);
                                            }}
                                        />
                                        <button className={styles.stepBtn} onClick={() => setEditQtyPerLevel(Math.min(99, editQtyPerLevel + 1))}>＋</button>
                                    </div>
                                    <div style={{ display: 'flex', gap: '8px' }}>
                                        <button
                                            onClick={() => handleSaveEdit(s)}
                                            style={{ flex: 1, padding: '6px', fontSize: '12px', border: '1px solid var(--brand)', borderRadius: '4px', background: 'var(--brand)', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}
                                        >
                                            <Save size={14} /> 儲存
                                        </button>
                                        <button
                                            onClick={handleCancelEdit}
                                            style={{ flex: 1, padding: '6px', fontSize: '12px', border: '1px solid var(--border)', borderRadius: '4px', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '4px' }}
                                        >
                                            <X size={14} /> 取消
                                        </button>
                                    </div>
                                </div>
                            ) : (
                                // View mode
                                <>
                                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                            <span style={{ fontSize: '13px', fontWeight: 600 }}>
                                                {s.name}
                                            </span>
                                            {s.enabled && (
                                                <span style={{ fontSize: '10px', padding: '2px 6px', borderRadius: '3px', backgroundColor: 'var(--brand)', color: 'white' }}>
                                                    運行中
                                                </span>
                                            )}
                                        </div>
                                        <div style={{ display: 'flex', gap: '4px' }}>
                                            {!s.enabled && (
                                                <>
                                                    <button
                                                        onClick={() => handleStartEdit(s)}
                                                        style={{ padding: '4px 8px', fontSize: '11px', border: '1px solid var(--border)', borderRadius: '4px', background: 'transparent', cursor: 'pointer' }}
                                                        title='編輯策略'
                                                    >
                                                        <Edit2 size={12} />
                                                    </button>
                                                    <button
                                                        onClick={() => handleArm(s.id)}
                                                        style={{ padding: '4px 8px', fontSize: '11px', border: '1px solid var(--border)', borderRadius: '4px', background: 'transparent', cursor: 'pointer' }}
                                                        title='啟動策略'
                                                    >
                                                        <Play size={12} />
                                                    </button>
                                                </>
                                            )}
                                            {s.enabled && (
                                                <button
                                                    onClick={() => handleDisarm(s.id)}
                                                    style={{ padding: '4px 8px', fontSize: '11px', border: '1px solid var(--border)', borderRadius: '4px', background: 'transparent', cursor: 'pointer' }}
                                                    title='停止策略'
                                                >
                                                    <Square size={12} />
                                                </button>
                                            )}
                                            {!s.enabled && (
                                                <button
                                                    onClick={() => handleDelete(s.id)}
                                                    style={{ padding: '4px 8px', fontSize: '11px', border: '1px solid var(--border)', borderRadius: '4px', background: 'transparent', cursor: 'pointer' }}
                                                    title='刪除策略'
                                                >
                                                    <Trash2 size={12} />
                                                </button>
                                            )}
                                        </div>
                                    </div>

                                    <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '8px' }}>
                                        {s.side === 'Buy' ? '多方' : '空方'} · 起始 {fmtPrice(s.startPrice)} · {STEP_MODE_LABELS[s.stepMode]} {s.stepValue} · {s.numLevels}檔 × {s.qtyPerLevel}
                                    </div>

                                    <div style={{ fontSize: '10px', marginBottom: '6px', display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid var(--border)', color: 'var(--text-muted)' }}>
                                        <span style={{ flex: 1 }}>檔位</span>
                                        <span style={{ flex: 2, textAlign: 'right' }}>進場價</span>
                                        <span style={{ flex: 2, textAlign: 'right' }}>出場價</span>
                                        <span style={{ flex: 1, textAlign: 'center' }}>狀態</span>
                                    </div>

                                    {s.levels.slice(0, 5).map((lv) => (
                                        <div
                                            key={lv.idx}
                                            style={{
                                                fontSize: '10px',
                                                display: 'flex',
                                                justifyContent: 'space-between',
                                                padding: '3px 0',
                                            }}
                                        >
                                            <span style={{ flex: 1 }}>#{lv.idx + 1}</span>
                                            <span style={{ flex: 2, textAlign: 'right' }}>{fmtPrice(lv.entryPrice)}</span>
                                            <span style={{ flex: 2, textAlign: 'right' }}>{fmtPrice(lv.exitPrice)}</span>
                                            <span style={{ flex: 1, textAlign: 'center' }}>
                                                {lv.state === 'idle' && '待命'}
                                                {lv.state === 'entry-working' && '掛單中'}
                                                {lv.state === 'held' && `持有${lv.entryFillQty}`}
                                                {lv.state === 'exit-working' && '出場中'}
                                                {lv.state === 'done' && '完成'}
                                            </span>
                                        </div>
                                    ))}

                                    {s.levels.length > 5 && (
                                        <div style={{ fontSize: '10px', color: 'var(--text-muted)', textAlign: 'center', padding: '4px 0' }}>
                                            ... 還有 {s.levels.length - 5} 檔
                                        </div>
                                    )}

                                    <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '8px', fontSize: '11px', paddingTop: '8px', borderTop: '1px solid var(--border)' }}>
                                        <span>庫存: {totalInventory(s)}</span>
                                        <span className={totalPnL(s) >= 0 ? panel.dirText.up : panel.dirText.down}>
                                            已實現: {totalPnL(s) >= 0 ? '+' : ''}{Math.round(totalPnL(s))}
                                        </span>
                                    </div>
                                </>
                            )}
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
