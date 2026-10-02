import type { IPriceLine, ISeriesApi } from 'lightweight-charts';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { ensureBracketHost, registerBracket, registrationFailureText } from '../lib/bracket';
import {
    activeEstStages,
    defaultEstPlan,
    estAction,
    estPlanErrors,
    estPlanRisk,
    type EstPlan,
    type EstSide,
    type EstStageIndex,
} from '../lib/chart-est-plan';
import { requestOrderConfirm } from '../lib/order-confirm';
import { currentProtectionEnv } from '../lib/protection-env';
import { notify, placeQuickOrder } from '../lib/trade';
import type { ContractBase } from '../lib/types/contract';
import type { Account } from '../lib/types/portfolio';
import { fmtPrice } from '../lib/utils/format';
import { roundToTick, tickSizeFor } from '../lib/utils/ticksize';
import * as styles from './chart-est-planner.css';

type LineKey = `${'E' | 'S' | 'T'}${EstStageIndex}`;

export function ChartEstPlanner({
    contract,
    lastPrice,
    account,
    chartHostRef,
    candleSeriesRef,
    onOrdersChanged,
}: {
    contract: ContractBase;
    lastPrice: number | null;
    account: Account | null;
    chartHostRef: RefObject<HTMLDivElement | null>;
    candleSeriesRef: RefObject<ISeriesApi<'Candlestick'> | null>;
    onOrdersChanged?: () => void;
}) {
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [plan, setPlan] = useState<EstPlan | null>(null);
    const planRef = useRef(plan);
    planRef.current = plan;
    const linesRef = useRef(new Map<LineKey, IPriceLine>());
    const dragRef = useRef<LineKey | null>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const accountRef = useRef(account);
    accountRef.current = account;
    const [panelAt, setPanelAt] = useState<{ x: number; y: number } | null>(null);
    const panelDrag = useRef<{ id: number; x: number; y: number; left: number; top: number } | null>(null);
    const isFutures = contract.security_type === 'FUT' && !(contract as { combo?: unknown }).combo;

    const start = (side: EstSide) => {
        if (!isFutures || !lastPrice || !Number.isFinite(lastPrice)) {
            notify({ kind: 'err', title: '無法建立 E/S/T', body: '僅支援具有有效現價的單一期貨契約' });
            return;
        }
        const pointValue = Number((contract as ContractBase & { multiplier?: number }).multiplier) || 200;
        setPlan(defaultEstPlan(side, roundToTick(contract, lastPrice), tickSizeFor(contract, lastPrice), pointValue));
        setOpen(true);
    };

    const patchStage = (index: EstStageIndex, field: 'entry' | 'stop' | 'target' | 'quantity' | 'enabled', value: number | boolean) => {
        setPlan((current) => current ? {
            ...current,
            stages: current.stages.map((stage) => stage.index === index ? { ...stage, [field]: value } : stage) as EstPlan['stages'],
        } : current);
    };

    // Visible E/S/T price lines. They are deliberately independent from the
    // drawing subsystem: these lines are order intent and disappear on close.
    useEffect(() => {
        const series = candleSeriesRef.current;
        for (const line of linesRef.current.values()) series?.removePriceLine(line);
        linesRef.current.clear();
        if (!series || !open || !plan) return;
        for (const stage of activeEstStages(plan)) {
            for (const [kind, price, color] of [
                ['E', stage.entry, '#3d8bff'],
                ['S', stage.stop, '#ff4d5f'],
                ['T', stage.target, '#35d09a'],
            ] as const) {
                const key = `${kind}${stage.index}` as LineKey;
                linesRef.current.set(key, series.createPriceLine({
                    price,
                    color,
                    lineWidth: 1,
                    axisLabelVisible: true,
                    title: key,
                }));
            }
        }
        return () => {
            for (const line of linesRef.current.values()) series.removePriceLine(line);
            linesRef.current.clear();
        };
    }, [open, plan, candleSeriesRef]);

    // Wide invisible hit area around each thin line keeps dragging easy.
    useEffect(() => {
        const host = chartHostRef.current;
        const series = candleSeriesRef.current;
        if (!host || !series || !open) return;
        const priceFor = (key: LineKey, p: EstPlan) => {
            const stage = p.stages[Number(key.slice(1)) - 1]!;
            return key[0] === 'E' ? stage.entry : key[0] === 'S' ? stage.stop : stage.target;
        };
        const down = (event: PointerEvent) => {
            if ((event.target as HTMLElement | null)?.closest('[data-est-panel]')) return;
            const current = planRef.current;
            if (!current) return;
            const y = event.clientY - host.getBoundingClientRect().top;
            let best: { key: LineKey; d: number } | null = null;
            for (const key of linesRef.current.keys()) {
                const py = series.priceToCoordinate(priceFor(key, current));
                if (py === null) continue;
                const d = Math.abs(py - y);
                if (d <= 10 && (!best || d < best.d)) best = { key, d };
            }
            if (!best) return;
            dragRef.current = best.key;
            host.setPointerCapture(event.pointerId);
            event.preventDefault();
            event.stopImmediatePropagation();
        };
        const move = (event: PointerEvent) => {
            const key = dragRef.current;
            if (!key) return;
            const raw = series.coordinateToPrice(event.clientY - host.getBoundingClientRect().top);
            if (raw === null) return;
            const field = key[0] === 'E' ? 'entry' : key[0] === 'S' ? 'stop' : 'target';
            patchStage(Number(key.slice(1)) as EstStageIndex, field, roundToTick(contract, Number(raw)));
            event.preventDefault();
            event.stopImmediatePropagation();
        };
        const up = (event: PointerEvent) => {
            if (!dragRef.current) return;
            dragRef.current = null;
            if (host.hasPointerCapture(event.pointerId)) host.releasePointerCapture(event.pointerId);
            event.preventDefault();
            event.stopImmediatePropagation();
        };
        host.addEventListener('pointerdown', down, true);
        host.addEventListener('pointermove', move, true);
        host.addEventListener('pointerup', up, true);
        host.addEventListener('pointercancel', up, true);
        return () => {
            host.removeEventListener('pointerdown', down, true);
            host.removeEventListener('pointermove', move, true);
            host.removeEventListener('pointerup', up, true);
            host.removeEventListener('pointercancel', up, true);
        };
    }, [open, contract, chartHostRef, candleSeriesRef]);

    const submit = async () => {
        if (!plan || !lastPrice || busy) return;
        const errors = estPlanErrors(plan, lastPrice);
        if (errors.length) {
            notify({ kind: 'err', title: 'E/S/T 計畫不合法', body: errors.join('；') });
            return;
        }
        if (!account?.signed || account.account_type !== 'F') {
            notify({ kind: 'err', title: '未建立計畫', body: '請先明確選擇已簽署的期貨帳戶' });
            return;
        }
        const env = currentProtectionEnv();
        if (!env) {
            notify({ kind: 'err', title: '未建立計畫', body: '伺服器模式尚未確認' });
            return;
        }
        const stages = activeEstStages(plan);
        const action = estAction(plan.side);
        const summary = stages.map((s) => `E${s.index} ${fmtPrice(s.entry)} / S${s.index} ${fmtPrice(s.stop)} / T${s.index} ${fmtPrice(s.target)} / ${s.quantity}口`).join('；');
        try {
            await ensureBracketHost();
        } catch (error) {
            notify({ kind: 'err', title: '未建立計畫', body: error instanceof Error ? error.message : String(error) });
            return;
        }
        const approved = await requestOrderConfirm({
            code: contract.code,
            name: (contract as ContractBase & { name?: string }).name,
            action,
            price: stages[0]!.entry,
            quantity: stages.reduce((sum, s) => sum + s.quantity, 0),
            unit: '口',
            note: `多段 E/S/T 限價計畫｜${summary}｜總風險約 NT$${Math.round(estPlanRisk(plan)).toLocaleString()}｜成交後由 App-local OCO 監控；App、網路或行情中斷時不保證觸發`,
        });
        if (!approved) return;
        setBusy(true);
        const captured = `${account.broker_id}|${account.account_id}`;
        const orderCode = contract.target_code && /R[12]$/.test(contract.code) ? contract.target_code : contract.code;
        const orderContract = orderCode === contract.code ? contract : { ...contract, code: orderCode, target_code: null };
        let submitted = 0;
        try {
            for (const stage of stages) {
                const trade = await placeQuickOrder(orderContract, action, stage.entry, stage.quantity, {
                    account,
                    ocType: 'New',
                    orderType: 'ROD',
                    source: 'auto',
                    beforeSend: () => {
                        const now = currentProtectionEnv();
                        if (now !== env) throw Object.assign(new Error('交易環境在確認後已切換'), { tradingGateRejected: true });
                        const active = accountRef.current;
                        if (!active || `${active.broker_id}|${active.account_id}` !== captured) throw Object.assign(new Error('帳戶在確認後已切換'), { tradingGateRejected: true });
                    },
                });
                submitted += 1;
                try {
                    await registerBracket({
                        env,
                        account: { account_type: 'F', broker_id: account.broker_id, account_id: account.account_id },
                        orderId: trade.order.id,
                        seqno: trade.order.seqno,
                        quoteCode: contract.code,
                        orderCode: trade.contract?.target_code || trade.contract?.code || orderCode,
                        securityType: contract.security_type as 'FUT' | 'OPT',
                        exchange: contract.exchange ?? '',
                        action,
                        quantity: stage.quantity,
                        stopPrice: stage.stop,
                        takePrice: stage.target,
                    });
                } catch (error) {
                    throw new Error(`E${stage.index} 已送出；${registrationFailureText(error)}`);
                }
            }
            notify({ kind: 'ok', title: 'E/S/T 計畫已建立', body: `${submitted} 段限價進場已送出；成交後各自啟動 OCO` });
            onOrdersChanged?.();
            setOpen(false);
            setPlan(null);
        } catch (error) {
            notify({ kind: 'err', title: submitted ? 'E/S/T 計畫部分建立' : 'E/S/T 計畫未建立', body: error instanceof Error ? error.message : String(error) });
            onOrdersChanged?.();
        } finally {
            setBusy(false);
        }
    };

    const errors = plan && lastPrice ? estPlanErrors(plan, lastPrice) : [];
    return (
        <>
            <button className={styles.launch} disabled={!isFutures} onClick={() => open ? setOpen(false) : start('long')} title='圖形 E/S/T 多段括號計畫'>E/S/T</button>
            {open && plan && (
                <div ref={panelRef} data-est-panel className={styles.panel} style={panelAt ? { left: panelAt.x, top: panelAt.y, right: 'auto' } : undefined}>
                    <div className={styles.header}
                        onDoubleClick={() => setPanelAt(null)}
                        onPointerDown={(e) => { if (e.button !== 0) return; const r = panelRef.current?.getBoundingClientRect(); if (!r) return; e.currentTarget.setPointerCapture(e.pointerId); panelDrag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, left: r.left, top: r.top }; }}
                        onPointerMove={(e) => { const d = panelDrag.current; const panel = panelRef.current; if (!d || d.id !== e.pointerId || !panel) return; setPanelAt({ x: Math.max(0, Math.min(d.left + e.clientX - d.x, window.innerWidth - panel.offsetWidth)), y: Math.max(0, Math.min(d.top + e.clientY - d.y, window.innerHeight - panel.offsetHeight)) }); }}
                        onPointerUp={(e) => { if (panelDrag.current?.id === e.pointerId) panelDrag.current = null; }}>
                        <strong>圖形 E/S/T 計畫</strong><span>拖曳線或輸入價格</span>
                    </div>
                    <div className={styles.sides}><button className={plan.side === 'long' ? styles.active : ''} onClick={() => start('long')}>做多</button><button className={plan.side === 'short' ? styles.active : ''} onClick={() => start('short')}>做空</button></div>
                    <label className={styles.toggle}><input type='checkbox' checked={plan.multiStage} onChange={(e) => setPlan({ ...plan, multiStage: e.target.checked })} />啟用三段進場</label>
                    <div className={styles.grid}>
                        {plan.stages.map((stage) => (stage.index === 1 || plan.multiStage) && <div className={styles.stage} key={stage.index}>
                            <label className={styles.stageToggle}><input type='checkbox' disabled={stage.index === 1} checked={stage.index === 1 || stage.enabled} onChange={(e) => patchStage(stage.index, 'enabled', e.target.checked)} />第{stage.index}段</label>
                            {(['entry', 'stop', 'target'] as const).map((field, i) => <label key={field}>{(['E', 'S', 'T'] as const)[i]}{stage.index}<input disabled={stage.index !== 1 && !stage.enabled} type='number' value={stage[field]} onChange={(e) => patchStage(stage.index, field, roundToTick(contract, Number(e.target.value)))} /></label>)}
                            <label>口數<input disabled={stage.index !== 1 && !stage.enabled} type='number' min={1} value={stage.quantity} onChange={(e) => patchStage(stage.index, 'quantity', Math.floor(Number(e.target.value)))} /></label>
                        </div>)}
                    </div>
                    <div className={styles.risk}><label>風險上限<input type='number' value={plan.riskBudget} onChange={(e) => setPlan({ ...plan, riskBudget: Number(e.target.value) })} /></label><label>每點 NT$<input type='number' value={plan.pointValue} onChange={(e) => setPlan({ ...plan, pointValue: Number(e.target.value) })} /></label><strong>估計 {Math.round(estPlanRisk(plan)).toLocaleString()}</strong></div>
                    {errors.length > 0 && <div className={styles.error}>{errors.join('；')}</div>}
                    <div className={styles.warning}>只支援不會立即成交的限價 E；成交後停損／停利由 App-local OCO 執行，App、行情與網路須持續運作。</div>
                    <div className={styles.actions}><button onClick={() => { setOpen(false); setPlan(null); }}>取消</button><button className={styles.primary} disabled={busy || errors.length > 0} onClick={() => void submit()}>{busy ? '建立中…' : '確認整組並建立'}</button></div>
                </div>
            )}
        </>
    );
}
