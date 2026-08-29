// src/components/combo-ticket.tsx — 期貨/選擇權組合單（managed 語意，issue #32）
//
// 腳不帶買賣別：整體 買進/賣出組合 是唯一方向，兩腳實際方向由
// 「組合型別 × 整體 action」展開並即時預覽（舊 directed 模式的整體
// action 被 server 忽略、腳 action 才算數 — 兩套並存是誤操作根源）。
// 期貨組合走 server 驗證（canonical 腳序）＋原生組合商品報價/5檔；
// 選擇權組合行情編碼未實作 → client 端 canonical 排序＋合成參考價，
// 下單時 server 以 Contract V2 Info 再驗一次。

import { Crosshair, Link2, Lock, Unlock, Zap } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { TICKET_ACTION_EVENT } from '../hooks/use-hotkeys';
import { useQuote, useTradingLive } from '../hooks/use-stream';
import { usePoll } from '../hooks/use-poll';
import { ensureContract } from '../lib/contracts-cache';
import {
    COMBO_TYPE_LABEL,
    comboMonthsLabel,
    deriveOptionShape,
    legActionsFor,
    orderFuturesLegs,
    syntheticComboQuote,
} from '../lib/combo';
import { useComboPick } from '../lib/combo-pick';
import { useOptionLegPick } from '../lib/option-pick';
import {
    buildComboContract,
    cancelComboOrder,
    comboLegReq,
    fetchComboSnapshot,
    fetchComboTrades,
    placeComboOrder,
    subscribeComboQuote,
    subscribeQuote,
    type ComboTrade,
    type ComboType,
    type ManagedComboContract,
} from '../lib/shioaji';
import { usePickedPrice } from '../lib/price-sync';
import { assertTradingLive, notify } from '../lib/trade';
import type { ContractInfo } from '../lib/types/contract';
import type { Snapshot } from '../lib/types/market';
import { fmtPrice } from '../lib/utils/format';
import { DepthLadder } from './depth-ladder';
import * as styles from './order-ticket.css';
import * as css from './combo-ticket.css';
import * as dock from './bottom-dock.css';
import * as panel from './panel.css';
import { OptionStrategyBuilder } from './combo-strategy';

interface LegState {
    input: string;
    contract: ContractInfo | null;
    error: boolean;
    locked: boolean; // 連動模式下鎖定的腳不被 T 字點擊覆寫
}

const EMPTY_LEG: LegState = {
    input: '',
    contract: null,
    error: false,
    locked: false,
};

// 兩腳解析後的組合判定結果
interface ComboResolution {
    kind: 'fut' | 'opt';
    combo: ManagedComboContract | null; // fut：server 驗證回的 canonical 合約
    comboType: ComboType | null; // opt：client 推導（曖昧時 null）
    ambiguous: ComboType[] | null;
}

function LegQuoteRow({ contract }: { contract: ContractInfo }) {
    const quote = useQuote(contract.code);
    const ba = quote?.bidask;
    const bid = ba ? Number(ba.bid_price[0]) : undefined;
    const ask = ba ? Number(ba.ask_price[0]) : undefined;
    return (
        <span className={css.legQuoteRow}>
            <span />
            <span>
                {contract.name}
                {contract.delivery_month &&
                !contract.name.includes(contract.delivery_month)
                    ? ` ${contract.delivery_month}`
                    : ''}
            </span>
            <span className={css.legQuoteRight}>
                買 {fmtPrice(bid)}／賣 {fmtPrice(ask)}
            </span>
        </span>
    );
}

// 組合淨價可以是 0 或負值，價格本身不能當「這一側存在」的訊號 —
// 用掛量判斷（空側量為 0）
const sideOk = (price: number, volume: number | undefined) =>
    Number.isFinite(price) && (volume ?? 0) > 0;

// 原生組合商品簿 — 有即時 BidAsk 就用標準五檔梯（DepthLadder，點價
// 直接帶入淨價欄），還沒有事件時以快照墊一行 L1（明標「快照」）
function ComboBook({
    code,
    snapshot,
}: {
    code: string;
    snapshot: Snapshot | null;
}) {
    const quote = useQuote(code);
    const ba = quote?.bidask;
    const last = quote?.tick
        ? Number(quote.tick.close)
        : snapshot && snapshot.total_volume > 0
          ? snapshot.close
          : undefined;
    const snapUsable =
        !!snapshot &&
        (sideOk(snapshot.buy_price, snapshot.buy_volume) ||
            sideOk(snapshot.sell_price, snapshot.sell_volume));
    return (
        <div className={css.section}>
            <span className={css.sectionTitle}>
                <span>
                    組合簿
                    {!ba && snapUsable && '（快照）'}
                </span>
                {last !== undefined && <span>成交 {fmtPrice(last)}</span>}
            </span>
            {ba ? (
                <DepthLadder code={code} />
            ) : snapUsable ? (
                <div className={css.snapRow}>
                    <span className={panel.dirText.up}>
                        買{' '}
                        {sideOk(snapshot!.buy_price, snapshot!.buy_volume)
                            ? `${fmtPrice(snapshot!.buy_price)}×${snapshot!.buy_volume}`
                            : '—'}
                    </span>
                    <span className={panel.dirText.down}>
                        賣{' '}
                        {sideOk(snapshot!.sell_price, snapshot!.sell_volume)
                            ? `${fmtPrice(snapshot!.sell_price)}×${snapshot!.sell_volume}`
                            : '—'}
                    </span>
                </div>
            ) : (
                <span className={styles.costRow}>等待組合行情…</span>
            )}
        </div>
    );
}

// 兩腳 L1 → canonical 合成報價（選擇權主用；期貨僅參考）。
// 任一腳單邊空簿即回 null — 缺一側的合成價會誤導到價監控
function useSynthetic(
    legs: LegState[],
    comboType: ComboType | null,
): { bid: number; ask: number } | null {
    const q0 = useQuote(legs[0]?.contract?.code ?? null);
    const q1 = useQuote(legs[1]?.contract?.code ?? null);
    if (!comboType) return null;
    const l1 = (q: typeof q0) => {
        const ba = q?.bidask;
        if (!ba) return null;
        const bid = Number(ba.bid_price[0]);
        const ask = Number(ba.ask_price[0]);
        return sideOk(bid, ba.bid_volume[0]) && sideOk(ask, ba.ask_volume[0])
            ? { bid, ask }
            : null;
    };
    return syntheticComboQuote(comboType, [l1(q0), l1(q1)]);
}

const ACTIVE_COMBO = new Set(['PendingSubmit', 'PreSubmitted', 'Submitted', 'PartFilled']);

export function ComboTicket() {
    const [legs, setLegs] = useState<LegState[]>([
        { ...EMPTY_LEG },
        { ...EMPTY_LEG },
    ]);
    const [action, setAction] = useState<'Buy' | 'Sell'>('Buy');
    const [price, setPrice] = useState('');
    const [qty, setQty] = useState(1);
    const [armed, setArmed] = useState(false);
    const [busy, setBusy] = useState(false);
    const [orderType, setOrderType] = useState<'IOC' | 'FOK' | 'ROD'>('IOC');
    const [linkChain, setLinkChain] = useState(false); // 連動 T 字
    const [sbOpen, setSbOpen] = useState(false); // 選擇權策略快建
    // 策略快建帶入時的型別意圖（曖昧 C+P 直接落 pickType，不用再手選）
    const intentRef = useRef<{ key: string; type: ComboType | null } | null>(
        null,
    );
    const [resolution, setResolution] = useState<ComboResolution | null>(null);
    const [comboError, setComboError] = useState<string | null>(null);
    // 曖昧型別（同履約價 C+P）由使用者明選 — 跨式與轉換/逆轉的腳方向
    // 完全不同，絕不能替使用者猜
    const [pickType, setPickType] = useState<ComboType | null>(null);
    const [comboSnapshot, setComboSnapshot] = useState<Snapshot | null>(null);
    const live = useTradingLive();
    const optPick = useOptionLegPick();

    const tradesPoll = usePoll<ComboTrade[]>(
        useCallback(() => fetchComboTrades().catch(() => []), []),
        10000,
    );

    // 到價監控 (issue #2): combos only fill IOC, so watch the book and fire
    // when it crosses the target — bounded attempts + cooldown so a
    // flickering quote can't machine-gun orders
    const [watchOn, setWatchOn] = useState(false);
    const [watchPrice, setWatchPrice] = useState('');
    const [attempts, setAttempts] = useState(0);
    const watchRef = useRef({ lastFire: 0, firing: false });
    const MAX_ATTEMPTS = 3;
    const COOLDOWN_MS = 5000;

    const setLeg = (i: number, patch: Partial<LegState>) =>
        setLegs((prev) =>
            prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)),
        );

    // 每腳一個 epoch — 快速連按策略/列表時同腳可能有多個解析在途，
    // 只有最新那筆能落地（否則慢的舊解析會蓋出 A/B 混腳）
    const legEpochs = useRef([0, 0]);
    const resolveCode = async (i: number, raw: string) => {
        const code = raw.trim().toUpperCase();
        if (!code) return;
        const epoch = ++legEpochs.current[i]!;
        try {
            let c = await ensureContract(code);
            if (c.security_type !== 'FUT' && c.security_type !== 'OPT') {
                throw new Error('組合單只支援期貨/選擇權');
            }
            // R1/R2 連續月別名不能當組合腳 — 換成真實近月合約，
            // delivery_month 等資訊才正確
            if (/R[12]$/.test(c.code) && c.target_code) {
                c = await ensureContract(c.target_code);
            }
            if (epoch !== legEpochs.current[i]) return; // 已被較新解析取代
            setLeg(i, { contract: c, error: false, input: c.code });
            await Promise.allSettled([
                subscribeQuote(c, 'Tick'),
                subscribeQuote(c, 'BidAsk'),
            ]);
        } catch {
            if (epoch !== legEpochs.current[i]) return;
            setLeg(i, { contract: null, error: true });
        }
    };
    const resolveLeg = (i: number) => resolveCode(i, legs[i]!.input);

    // 連動 T 字 (issue #1): a click in the 選擇權 T 字 fills the next
    // unlocked leg, alternating — lock a leg to pin it while you pick the
    // other. Refs avoid re-subscribing the picker on every leg edit.
    const legsRef = useRef(legs);
    legsRef.current = legs;

    // 組合商品列表點擊 → 兩腳整組帶入（canonical 序，明確意圖故不看
    // locked）；解析後走既有 legKey 流程再過一次 server 驗證
    const comboPick = useComboPick();
    useEffect(() => {
        if (!comboPick) return;
        const [l0, l1] = comboPick.combo.legs;
        if (!l0 || !l1) return;
        setLegs([
            { ...EMPTY_LEG, input: l0.code },
            { ...EMPTY_LEG, input: l1.code },
        ]);
        setArmed(false);
        void resolveCode(0, l0.code);
        void resolveCode(1, l1.code);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [comboPick?.seq]);
    useEffect(() => {
        if (!linkChain || !optPick) return;
        const cur = legsRef.current;
        // prefer an empty unlocked leg, else the first unlocked leg
        let target = cur.findIndex((l) => !l.locked && !l.contract);
        if (target < 0) target = cur.findIndex((l) => !l.locked);
        if (target < 0) return; // both locked
        void resolveCode(target, optPick.code);
        setArmed(false);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [optPick?.seq, linkChain]);

    // 兩腳都解析後：canonical 排序（可見的自動換序）＋型別判定。
    // 期貨走 server 驗證並訂閱原生組合報價；選擇權 client 端推導。
    const legKey = legs
        .map((l) => `${l.contract?.security_type ?? ''}${l.contract?.code ?? ''}`)
        .join('|');
    // server 說反序的自動換序每組腳只試一次（key 為無序腳對）
    const swapTried = useRef(new Set<string>());
    useEffect(() => {
        const [a, b] = [legs[0]?.contract, legs[1]?.contract];
        setResolution(null);
        setComboError(null);
        setComboSnapshot(null);
        if (!a || !b) return;
        if (a.security_type !== b.security_type) {
            setComboError('兩腳需同為期貨或同為選擇權');
            return;
        }
        if (a.code === b.code) {
            setComboError('兩腳不可為同一合約');
            return;
        }
        let stale = false;
        if (a.security_type === 'OPT') {
            const shape = deriveOptionShape(a, b);
            if (shape.error) {
                setComboError(shape.error);
                return;
            }
            if (shape.swapped) {
                // 換成 canonical 腳序（effect 會因 legKey 變動重跑一次）
                setLegs((prev) => [prev[1]!, prev[0]!]);
                return;
            }
            setResolution({
                kind: 'opt',
                combo: null,
                comboType: shape.comboType,
                ambiguous: shape.ambiguous,
            });
            return;
        }
        // FUT：先本地近月在前，再交給 server 驗 canonical＋家族
        const { swapped } = orderFuturesLegs(a, b);
        if (swapped) {
            setLegs((prev) => [prev[1]!, prev[0]!]);
            return;
        }
        (async () => {
            try {
                const combo = await buildComboContract([
                    comboLegReq(a),
                    comboLegReq(b),
                ]);
                if (stale) return;
                setResolution({
                    kind: 'fut',
                    combo,
                    comboType: combo.combo_type,
                    ambiguous: null,
                });
                await Promise.allSettled([
                    subscribeComboQuote(combo, 'Tick'),
                    subscribeComboQuote(combo, 'BidAsk'),
                ]);
                const snap = await fetchComboSnapshot(combo).catch(() => null);
                if (!stale) setComboSnapshot(snap);
            } catch (e) {
                if (stale) return;
                const msg = e instanceof Error ? e.message : String(e);
                const pairKey = [a.code, b.code].sort().join('|');
                if (/reversed/i.test(msg) && !swapTried.current.has(pairKey)) {
                    // server 認定的 canonical 序與本地排序不同（如同月週/月）
                    // — 每組腳只自動換一次，換過還被拒就直接顯示錯誤，
                    // 避免對無解訊息無限 ping-pong
                    swapTried.current.add(pairKey);
                    setLegs((prev) => [prev[1]!, prev[0]!]);
                } else {
                    setComboError(msg);
                }
            }
        })();
        return () => {
            stale = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [legKey]);

    // 不退訂組合報價 — 與全 app「訂了就留」慣例一致。server 端退訂
    // 沒有 refcount：這裡退訂會殺掉 K線/五檔等連動面板正在看的同一
    // 組合流（凍結但看起來活著），且 contracts-cache 的 subscribed
    // 集合會擋住重訂（QA round 10 MEDIUM）。

    // 生效的組合型別：期貨由 server、選擇權由推導、曖昧由使用者選
    const effectiveType: ComboType | null =
        resolution?.comboType ??
        (resolution?.ambiguous ? pickType : null) ??
        null;
    useEffect(() => {
        // 策略快建帶入的曖昧型別意圖：兩腳（不論順序）與意圖相符就
        // 直接套用，使用者不用再點一次跨式/轉逆。兩腳先後解析，
        // 過渡態（只解析一腳）不清 intent — 等兩腳齊了才判斷
        const codes = legs
            .map((l) => l.contract?.code)
            .filter((c): c is string => !!c)
            .sort();
        const intent = intentRef.current;
        if (intent && codes.length === 2) {
            if (intent.key === codes.join('|')) {
                setPickType(intent.type);
            } else {
                setPickType(null);
                intentRef.current = null;
            }
        } else {
            setPickType(null);
        }
        // 換組合後淨價回到自動帶入 — 殘留上一組的手動價會誤導
        setPriceTouched(false);
        setPrice('');
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [legKey]);

    const nativeQuote = useQuote(resolution?.combo?.code ?? null);
    // 即時原生 L1（雙邊都有掛量才算）— 到價監控只吃這個或合成，
    // 絕不吃快照：快照可能是前一節/收盤的殘值，盤前用它觸發等於
    // 對死資料自動下單
    const liveL1 = (() => {
        const ba = nativeQuote?.bidask;
        if (!ba) return null;
        const bid = Number(ba.bid_price[0]);
        const ask = Number(ba.ask_price[0]);
        return sideOk(bid, ba.bid_volume[0]) && sideOk(ask, ba.ask_volume[0])
            ? { bid, ask }
            : null;
    })();
    const snapL1 =
        comboSnapshot &&
        sideOk(comboSnapshot.buy_price, comboSnapshot.buy_volume) &&
        sideOk(comboSnapshot.sell_price, comboSnapshot.sell_volume)
            ? {
                  bid: comboSnapshot.buy_price,
                  ask: comboSnapshot.sell_price,
              }
            : null;
    const synth = useSynthetic(legs, effectiveType);
    // 淨價自動帶入：原生即時 → 快照 → 合成（快照只用於帶價，不觸發）
    const refQuote = liveL1 ?? snapL1 ?? synth;
    // 到價監控基準：只用即時資料
    const watchQuote = liveL1 ?? synth;

    const hasOpt = legs.some((l) => l.contract?.security_type === 'OPT');
    const decimals = hasOpt ? 1 : 0;
    // autofill price from reference mid until the user edits it
    const [priceTouched, setPriceTouched] = useState(false);
    useEffect(() => {
        if (!priceTouched && refQuote) {
            setPrice(((refQuote.bid + refQuote.ask) / 2).toFixed(decimals));
        }
    }, [refQuote?.bid, refQuote?.ask, priceTouched, decimals]); // eslint-disable-line react-hooks/exhaustive-deps

    // 組合五檔梯點價 → 直接帶入淨價（比照一般下單面板的點價行為）
    const picked = usePickedPrice(resolution?.combo?.code ?? null);
    useEffect(() => {
        if (!picked) return;
        setPriceTouched(true);
        setPrice(String(picked.price));
        setArmed(false);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [picked?.seq]);

    const ready =
        legs.every((l) => l.contract) &&
        !comboError &&
        !!resolution &&
        !!effectiveType &&
        (resolution.kind !== 'fut' || !!resolution.combo);
    const allFut =
        legs.length > 0 &&
        legs.every((l) => l.contract?.security_type === 'FUT');
    // 標準選擇權組合不可 ROD（期交所 9927 退單）；期貨跨月價差盤中可 ROD
    const orderTypes: ('IOC' | 'FOK' | 'ROD')[] = allFut
        ? ['IOC', 'FOK', 'ROD']
        : ['IOC', 'FOK'];
    // keep the selected order type valid as legs change
    useEffect(() => {
        if (!orderTypes.includes(orderType)) setOrderType('IOC');
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [allFut, hasOpt]);

    // B/S hotkeys switch the combo direction (issue #1 — was inert here)
    useEffect(() => {
        const onAction = (e: Event) => {
            const a = (e as CustomEvent).detail?.action;
            if (a === 'Buy' || a === 'Sell') {
                setAction(a);
                setArmed(false);
            }
        };
        window.addEventListener(TICKET_ACTION_EVENT, onAction);
        return () => window.removeEventListener(TICKET_ACTION_EVENT, onAction);
    }, []);

    // 每腳實際方向預覽 — 使用者下單前一定看得到兩腳各自會買還是賣
    const legDirs: ['Buy' | 'Sell', 'Buy' | 'Sell'] | null = effectiveType
        ? legActionsFor(effectiveType, action)
        : null;
    const dirSummary = legDirs
        ? legs
              .map(
                  (l, i) =>
                      `${legDirs[i] === 'Buy' ? '買' : '賣'}${l.contract?.code ?? ''}`,
              )
              .join('／')
        : '';

    const buildOrderCombo = () => ({
        legs:
            resolution!.kind === 'fut'
                ? resolution!.combo!.legs
                : legs.map((l) => comboLegReq(l.contract!)),
        // 只在必要時明給：曖昧由使用者選；期貨用 server 驗證值；其餘讓
        // server 以 Contract V2 推導（含 WeeklyTimeSpread 變體）
        combo_type:
            resolution!.kind === 'fut'
                ? resolution!.combo!.combo_type
                : resolution!.ambiguous
                  ? pickType
                  : null,
    });

    // watcher: buy when the ASK drops to target; sell when the BID rises.
    // 只認即時資料（原生簿或合成）— 快照殘值絕不當觸發依據
    useEffect(() => {
        if (!watchOn || !watchQuote || !ready) return;
        const target = Number(watchPrice);
        if (!Number.isFinite(target)) return;
        const hit =
            action === 'Buy'
                ? watchQuote.ask <= target
                : watchQuote.bid >= target;
        if (!hit) return;
        const w = watchRef.current;
        if (w.firing || Date.now() - w.lastFire < COOLDOWN_MS) return;
        if (attempts >= MAX_ATTEMPTS) {
            setWatchOn(false);
            notify({
                kind: 'info',
                title: '🎯 到價監控停止',
                body: `已達 ${MAX_ATTEMPTS} 次嘗試上限，請確認成交狀況`,
            });
            return;
        }
        w.firing = true;
        w.lastFire = Date.now();
        setAttempts((a) => a + 1);
        (async () => {
            try {
                const trade = await placeComboOrder(buildOrderCombo(), {
                    action,
                    price: target,
                    quantity: qty,
                    price_type: 'LMT',
                    order_type: 'IOC',
                    octype: 'Auto',
                });
                notify({
                    kind: 'ok',
                    title: `🎯 到價觸發第 ${attempts + 1} 次`,
                    body: `${action === 'Buy' ? '買進' : '賣出'}組合（${dirSummary}）${qty} @ ${target}（${trade.status.status}）— 請確認成交，避免重複下單`,
                });
                tradesPoll.refresh();
            } catch (e) {
                notify({
                    kind: 'err',
                    title: '到價下單失敗',
                    body: e instanceof Error ? e.message : String(e),
                });
            } finally {
                watchRef.current.firing = false;
            }
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [watchQuote?.bid, watchQuote?.ask, watchOn, watchPrice, action, qty, ready, attempts]);

    // disarm the watcher when the combo changes
    useEffect(() => {
        setWatchOn(false);
        setAttempts(0);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [legKey, effectiveType]);

    const execute = async () => {
        if (!armed) {
            setArmed(true);
            return;
        }
        setArmed(false);
        if (!ready) return;
        // 淨價可為 0 或負，但空白/非數字不可默默變 0 — LMT 0 在多數
        // 組合是會成交的價位
        const p = Number(price);
        if (!price.trim() || !Number.isFinite(p)) {
            notify({
                kind: 'err',
                title: '組合單未送出',
                body: '請輸入有效淨價（可為 0 或負值）',
            });
            return;
        }
        setBusy(true);
        try {
            assertTradingLive();
            const trade = await placeComboOrder(buildOrderCombo(), {
                action,
                price: p,
                quantity: qty,
                price_type: 'LMT',
                order_type: orderType,
                octype: 'Auto',
            });
            notify({
                kind: 'ok',
                title: '🧩 組合單已送出',
                body: `${trade.status.status} #${trade.order.seqno || trade.order.id.slice(0, 8)}`,
            });
            tradesPoll.refresh();
        } catch (e) {
            notify({
                kind: 'err',
                title: '組合單失敗',
                body: e instanceof Error ? e.message : String(e),
            });
        } finally {
            setBusy(false);
        }
    };

    const doCancel = async (t: ComboTrade) => {
        try {
            await cancelComboOrder(t.order.id);
            notify({ kind: 'ok', title: '🗑 組合刪單已送出', body: t.order.id });
        } catch (e) {
            notify({
                kind: 'err',
                title: '組合刪單失敗',
                body: e instanceof Error ? e.message : String(e),
            });
        }
        tradesPoll.refresh();
    };

    const working = (tradesPoll.data ?? []).filter((t) =>
        ACTIVE_COMBO.has(t.status.status),
    );

    return (
        <div className={styles.body}>
            <div className={styles.fieldRow}>
                <button
                    className={styles.iconToggle[sbOpen ? 'on' : 'off']}
                    title='選擇權策略快建：選策略與履約價，兩腳自動帶入'
                    onClick={() => setSbOpen((v) => !v)}
                    style={{ width: 'auto', padding: '2px 8px', gap: '4px' }}
                >
                    <Zap size={11} /> 策略快建
                </button>
                <button
                    className={styles.iconToggle[linkChain ? 'on' : 'off']}
                    title='連動選擇權 T 字：點 T 字報價自動填入未鎖定的腳'
                    onClick={() => setLinkChain((v) => !v)}
                    style={{ width: 'auto', padding: '2px 8px', gap: '4px' }}
                >
                    <Link2 size={11} /> 連動 T 字
                </button>
                {linkChain && (
                    <span className={styles.costRow} style={{ margin: 0 }}>
                        點 T 字填入未鎖定的腳，交替填兩腳
                    </span>
                )}
            </div>
            {sbOpen && (
                <OptionStrategyBuilder
                    onBuild={(codes, intended) => {
                        intentRef.current = {
                            key: [...codes].sort().join('|'),
                            type: intended,
                        };
                        setLegs([
                            { ...EMPTY_LEG, input: codes[0] },
                            { ...EMPTY_LEG, input: codes[1] },
                        ]);
                        setArmed(false);
                        void resolveCode(0, codes[0]);
                        void resolveCode(1, codes[1]);
                    }}
                />
            )}
            <div className={css.section}>
                {legs.map((leg, i) => (
                    <div key={i}>
                        <div className={css.legRow}>
                            <span
                                className={
                                    css.dirChip[
                                        legDirs && leg.contract
                                            ? legDirs[i] === 'Buy'
                                                ? 'buy'
                                                : 'sell'
                                            : 'none'
                                    ]
                                }
                                title={
                                    legDirs && leg.contract
                                        ? `此腳將${legDirs[i] === 'Buy' ? '買進' : '賣出'}`
                                        : `腳 ${i + 1}`
                                }
                            >
                                {legDirs && leg.contract
                                    ? legDirs[i] === 'Buy'
                                        ? '買'
                                        : '賣'
                                    : i + 1}
                            </span>
                            <input
                                className={styles.numInput}
                                placeholder='代碼 如 TXFF6 / TX417000C6'
                                value={leg.input}
                                style={leg.error ? { borderColor: 'var(--danger, #f23645)' } : undefined}
                                onChange={(e) => setLeg(i, { input: e.target.value, contract: null })}
                                onKeyDown={(e) => e.key === 'Enter' && resolveLeg(i)}
                                onBlur={() => resolveLeg(i)}
                            />
                            {linkChain && (
                                <button
                                    className={styles.iconToggle[leg.locked ? 'on' : 'off']}
                                    title={leg.locked ? '已鎖定（T 字點擊不覆寫）' : '鎖定此腳'}
                                    onClick={() => setLeg(i, { locked: !leg.locked })}
                                >
                                    {leg.locked ? (
                                        <Lock size={11} />
                                    ) : (
                                        <Unlock size={11} />
                                    )}
                                </button>
                            )}
                        </div>
                        {leg.contract && (
                            <LegQuoteRow contract={leg.contract} />
                        )}
                    </div>
                ))}
            </div>

            {comboError && (
                <span className={styles.costRow}>
                    <span className={panel.dirText.down}>⚠ {comboError}</span>
                </span>
            )}

            {resolution?.ambiguous && (
                <div className={styles.fieldRow}>
                    <span className={styles.fieldLabel}>型別</span>
                    <div className={styles.segGroup}>
                        {resolution.ambiguous.map((t) => (
                            <button
                                key={t}
                                className={styles.seg[pickType === t ? 'on' : 'off']}
                                onClick={() => {
                                    setPickType(t);
                                    setArmed(false);
                                }}
                            >
                                {COMBO_TYPE_LABEL[t]}
                            </button>
                        ))}
                    </div>
                </div>
            )}
            {effectiveType && !resolution?.ambiguous && (
                <div className={css.infoRow}>
                    <span className={css.typeBadge}>
                        {COMBO_TYPE_LABEL[effectiveType]}
                    </span>
                    {resolution?.combo && (
                        <>
                            <span>
                                {comboMonthsLabel(resolution.combo.code)}
                            </span>
                            <span className={css.infoCode}>
                                {resolution.combo.code}
                            </span>
                        </>
                    )}
                </div>
            )}

            {resolution?.combo && (
                <ComboBook
                    code={resolution.combo.code}
                    snapshot={comboSnapshot}
                />
            )}
            {/* 合成參考只在沒有原生組合簿時顯示（選擇權組合、或期貨簿
                尚無行情）— 原生簿在場時它只是雜訊 */}
            {synth && !nativeQuote?.bidask && (
                <div className={css.synthRow}>
                    <span>合成參考</span>
                    <span className={`${css.synthCell} ${panel.dirText.up}`}>
                        買 {fmtPrice(synth.bid)}
                    </span>
                    <span className={css.synthCell}>
                        中 {fmtPrice((synth.bid + synth.ask) / 2)}
                    </span>
                    <span className={`${css.synthCell} ${panel.dirText.down}`}>
                        賣 {fmtPrice(synth.ask)}
                    </span>
                </div>
            )}

            <div className={styles.fieldRow}>
                <span className={styles.fieldLabel}>組合</span>
                <div className={styles.segGroup}>
                    {(['Buy', 'Sell'] as const).map((a) => (
                        <button
                            key={a}
                            className={styles.seg[action === a ? 'on' : 'off']}
                            onClick={() => {
                                setAction(a);
                                setArmed(false);
                            }}
                        >
                            {a === 'Buy' ? '買進組合' : '賣出組合'}
                        </button>
                    ))}
                </div>
            </div>
            {legDirs && (
                <span className={css.dirSummaryRow}>
                    {action === 'Buy' ? '買進' : '賣出'}組合 ＝{' '}
                    {legs.map((l, i) => (
                        <span key={i}>
                            {i > 0 && '＋'}
                            <span
                                className={
                                    panel.dirText[
                                        legDirs[i] === 'Buy' ? 'up' : 'down'
                                    ]
                                }
                            >
                                {legDirs[i] === 'Buy' ? '買' : '賣'}
                            </span>
                            {l.contract?.code}
                        </span>
                    ))}
                </span>
            )}
            <div className={styles.fieldRow}>
                <span className={styles.fieldLabel}>淨價</span>
                <input
                    className={styles.numInput}
                    value={price}
                    inputMode='decimal'
                    onChange={(e) => {
                        setPriceTouched(true);
                        setPrice(e.target.value);
                        setArmed(false);
                    }}
                />
                <span className={styles.fieldLabel}>量</span>
                <input
                    className={styles.numInput}
                    value={qty}
                    inputMode='numeric'
                    onChange={(e) => {
                        const v = Number(e.target.value);
                        if (Number.isInteger(v) && v >= 1) setQty(v);
                    }}
                />
            </div>

            <div className={styles.fieldRow}>
                <span className={styles.fieldLabel}>條件</span>
                <div className={styles.segGroup}>
                    {orderTypes.map((ot) => (
                        <button
                            key={ot}
                            className={styles.seg[orderType === ot ? 'on' : 'off']}
                            onClick={() => {
                                setOrderType(ot);
                                setArmed(false);
                            }}
                            title={
                                ot === 'IOC'
                                    ? '立即成交否則取消'
                                    : ot === 'FOK'
                                      ? '全部成交否則取消'
                                      : '掛單等候（可掛芭樂價）'
                            }
                        >
                            {ot}
                        </button>
                    ))}
                </div>
            </div>

            <button
                className={styles.execBtn[armed ? 'armed' : action === 'Buy' ? 'buy' : 'sell']}
                disabled={busy || !ready || !live}
                onClick={execute}
            >
                {!live
                    ? '⚠ 行情未連線，暫停下單'
                    : busy
                      ? '傳送中…'
                      : armed
                        ? `確認${action === 'Buy' ? '買進' : '賣出'}組合 ${qty} @ ${price}（${dirSummary}）`
                        : ready
                          ? `${action === 'Buy' ? '買進' : '賣出'}組合下單`
                          : resolution?.ambiguous && !pickType
                            ? '先選擇組合型別'
                            : '先輸入兩腳合約代碼'}
            </button>

            <div className={styles.fieldRow}>
                <span className={styles.fieldLabel}>到價</span>
                <input
                    className={styles.numInput}
                    placeholder='目標淨價'
                    value={watchPrice}
                    inputMode='decimal'
                    disabled={watchOn}
                    onChange={(e) => setWatchPrice(e.target.value)}
                />
                <button
                    className={styles.seg[watchOn ? 'on' : 'off']}
                    disabled={!ready || !watchPrice}
                    title={`組合${action === 'Buy' ? '賣價跌至' : '買價漲至'}目標時自動送 IOC（最多 ${MAX_ATTEMPTS} 次，間隔 ${COOLDOWN_MS / 1000}s）`}
                    onClick={() => {
                        setAttempts(0);
                        setWatchOn((v) => !v);
                    }}
                >
                    {watchOn ? (
                        <>
                            <Crosshair size={10} style={{ verticalAlign: '-1px' }} />{' '}
                            監控中 {attempts}/{MAX_ATTEMPTS}
                        </>
                    ) : (
                        '啟動監控'
                    )}
                </button>
            </div>
            {watchOn && (
                <span className={styles.costRow}>
                    <span className={panel.dirText.up}>
                        ⚠ 到價會自動送單：IOC 可能部分成交後再次觸發，請盯緊成交回報避免重複部位
                    </span>
                </span>
            )}

            {working.length > 0 && (
                <>
                    <span className={styles.fieldLabel}>在途組合單</span>
                    {working.map((t) => (
                        <span key={t.order.id} className={styles.costRow}>
                            {t.order.action === 'Buy' ? '買' : '賣'}{' '}
                            {t.contract.legs
                                .map((l) =>
                                    l.action
                                        ? `${l.action === 'Buy' ? '+' : '−'}${l.code}`
                                        : l.code,
                                )
                                .join(' ')}{' '}
                            {t.order.quantity} @ {fmtPrice(t.order.price)}（
                            {t.status.status}）{' '}
                            <button
                                className={dock.cancelBtn}
                                onClick={() => void doCancel(t)}
                            >
                                刪單
                            </button>
                        </span>
                    ))}
                </>
            )}
        </div>
    );
}
