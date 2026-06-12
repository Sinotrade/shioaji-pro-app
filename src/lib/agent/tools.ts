// src/lib/agent/tools.ts — the agent's hands: everything the terminal can
// do, exposed as provider-neutral tools. Trading tools are filtered by
// policy; under 'auto' place_order executes through the same risk-gated
// path as every human order.

import { ensureContract } from '../contracts-cache';
import { activityLog } from './activity';
import { findPackage, readReference } from './marketplace';
import {
    cancelOrder,
    fetchAccountBalance,
    fetchKbars,
    fetchMargin,
    fetchPositions,
    fetchScanner,
    fetchSnapshots,
    fetchTrades,
} from '../shioaji';
import { getQuote } from '../stream';
import { notify, placeQuickOrder } from '../trade';
import { ACTIVE_ORDER_STATUSES } from '../types/order';
import { dateStrOffset } from '../utils/kbars';
import { findSkill, saveSkill } from './skills';
import type {
    AgentPolicy,
    OrderProposal,
    ToolDef,
} from './types';

export const TOOL_DEFS: ToolDef[] = [
    {
        name: 'get_quote',
        description:
            '取得單一商品即時報價（價格、漲跌、買賣價、量、漲跌停）。查多檔請改用 get_snapshots 批次，不要逐檔呼叫',
        schema: {
            type: 'object',
            properties: {
                code: { type: 'string', description: '代碼，如 2330、TXFR1' },
            },
            required: ['code'],
        },
    },
    {
        name: 'get_snapshots',
        description:
            '一次取得多檔商品的即時快照（收盤價、漲跌幅、量、額）— 查 2 檔以上一律用這個，一次呼叫完成',
        schema: {
            type: 'object',
            properties: {
                codes: {
                    type: 'array',
                    items: { type: 'string' },
                    description: '代碼清單，如 ["2330","0050","TXFR1"]，最多 50 檔',
                },
            },
            required: ['codes'],
        },
    },
    {
        name: 'get_positions',
        description: '取得所有持倉（股票+期貨）含損益',
        schema: { type: 'object', properties: {} },
    },
    {
        name: 'get_working_orders',
        description: '取得在途（未成交）委託單，含委託單 id',
        schema: { type: 'object', properties: {} },
    },
    {
        name: 'get_account',
        description: '取得帳務：交割帳戶餘額、期貨權益數/保證金/風險指標',
        schema: { type: 'object', properties: {} },
    },
    {
        name: 'get_kbar_summary',
        description: '商品近 N 日 K 線摘要（期間高低、收盤、漲跌幅）',
        schema: {
            type: 'object',
            properties: {
                code: { type: 'string' },
                days: { type: 'number', description: '預設 20，最大 120' },
            },
            required: ['code'],
        },
    },
    {
        name: 'get_scanner',
        description: '市場排行：漲幅/量/額前 N 名',
        schema: {
            type: 'object',
            properties: {
                rank: {
                    type: 'string',
                    enum: ['change_pct', 'volume', 'amount'],
                },
                count: { type: 'number', description: '預設 10' },
            },
            required: ['rank'],
        },
    },
    {
        name: 'get_user_activity',
        description:
            '取得使用者最近的操作軌跡（選了哪些商品、開了哪些面板、下了哪些單）— 用於觀察重複的工作流程並用 save_skill 收斂成技能',
        schema: {
            type: 'object',
            properties: {
                hours: { type: 'number', description: '回看幾小時，預設 24' },
            },
        },
    },
    {
        name: 'use_skill',
        description:
            '載入一個具名技能的完整內容（使用者技能的工作流程步驟，或市集技能包的 SKILL.md），然後照著執行',
        schema: {
            type: 'object',
            properties: { name: { type: 'string', description: '技能名稱' } },
            required: ['name'],
        },
    },
    {
        name: 'read_skill_reference',
        description:
            '讀取市集技能包的參考文件內容（如 shioaji 的 ORDERS.md／STREAMING.md）— 需要 API 細節時先 use_skill 看文件清單再讀對應檔案',
        schema: {
            type: 'object',
            properties: {
                skill: { type: 'string', description: '技能包名稱，如 shioaji' },
                file: { type: 'string', description: '文件檔名，如 ORDERS.md' },
            },
            required: ['skill', 'file'],
        },
    },
    {
        name: 'save_skill',
        description:
            '把剛完成的多步驟工作流程存成技能（procedural memory）。當你完成一個之後可能重複的非平凡任務時主動使用；同名技能會被更新改進',
        schema: {
            type: 'object',
            properties: {
                name: { type: 'string', description: '簡短技能名稱' },
                description: { type: 'string', description: '一句話描述' },
                instructions: {
                    type: 'string',
                    description: '可重複執行的步驟（含使用哪些工具）',
                },
            },
            required: ['name', 'description', 'instructions'],
        },
    },
    {
        name: 'notify_user',
        description: '發送 App 內通知給使用者（重要發現、警示）',
        schema: {
            type: 'object',
            properties: {
                title: { type: 'string' },
                body: { type: 'string' },
            },
            required: ['title', 'body'],
        },
    },
    {
        name: 'place_order',
        description:
            '下單。confirm 權限下產生提案卡待使用者確認；auto 權限下直接送出（受風控限制）',
        trading: true,
        schema: {
            type: 'object',
            properties: {
                code: { type: 'string' },
                action: { type: 'string', enum: ['Buy', 'Sell'] },
                price: { type: 'number', description: '限價；省略=市價' },
                quantity: { type: 'number' },
                reason: { type: 'string', description: '一句話理由' },
            },
            required: ['code', 'action', 'quantity', 'reason'],
        },
    },
    {
        name: 'cancel_order',
        description: '刪除一筆在途委託（用 get_working_orders 取得 id）',
        trading: true,
        schema: {
            type: 'object',
            properties: { order_id: { type: 'string' } },
            required: ['order_id'],
        },
    },
];

export function toolsForPolicy(policy: AgentPolicy): ToolDef[] {
    return policy === 'readonly'
        ? TOOL_DEFS.filter((t) => !t.trading)
        : TOOL_DEFS;
}

export interface ToolExecution {
    result: unknown;
    proposal?: OrderProposal; // confirm policy: surfaced as a card/notice
}

export async function executeTool(
    name: string,
    input: Record<string, unknown>,
    policy: AgentPolicy,
): Promise<ToolExecution> {
    switch (name) {
        case 'get_quote': {
            const c = await ensureContract(
                String(input.code ?? '').toUpperCase(),
            );
            const q = getQuote(c.code);
            const snap = q?.tick
                ? null
                : (await fetchSnapshots([c]).catch(() => []))[0];
            const close = q?.tick ? Number(q.tick.close) : snap?.close;
            const ref = c.reference;
            return {
                result: {
                    code: c.code,
                    name: c.name,
                    close,
                    change_pct:
                        close !== undefined && ref
                            ? `${(((close - ref) / ref) * 100).toFixed(2)}%`
                            : null,
                    bid: q?.bidask ? Number(q.bidask.bid_price[0]) : null,
                    ask: q?.bidask ? Number(q.bidask.ask_price[0]) : null,
                    total_volume:
                        q?.tick?.total_volume ?? snap?.total_volume ?? null,
                    limit_up: c.limit_up,
                    limit_down: c.limit_down,
                },
            };
        }
        case 'get_snapshots': {
            const codes = (
                Array.isArray(input.codes) ? input.codes : []
            )
                .map((c) => String(c).toUpperCase())
                .slice(0, 50);
            if (codes.length === 0)
                return { result: { error: 'codes 不可為空' } };
            const contracts = (
                await Promise.allSettled(codes.map((c) => ensureContract(c)))
            )
                .filter(
                    (
                        r,
                    ): r is PromiseFulfilledResult<
                        Awaited<ReturnType<typeof ensureContract>>
                    > => r.status === 'fulfilled',
                )
                .map((r) => r.value);
            const snaps = await fetchSnapshots(contracts).catch(() => []);
            const byCode = new Map(snaps.map((s) => [s.code, s]));
            return {
                result: contracts.map((c) => {
                    const s = byCode.get(c.code);
                    const ref = s ? s.close - s.change_price : 0;
                    return {
                        code: c.code,
                        name: c.name,
                        close: s?.close ?? null,
                        change_pct:
                            s && s.change_price && ref > 0
                                ? `${((s.change_price / ref) * 100).toFixed(2)}%`
                                : null,
                        total_volume: s?.total_volume ?? null,
                        total_amount: s?.total_amount ?? null,
                    };
                }),
            };
        }
        case 'get_positions': {
            const [s, f] = await Promise.allSettled([
                fetchPositions('S'),
                fetchPositions('F'),
            ]);
            return {
                result: [
                    ...(s.status === 'fulfilled' ? s.value : []),
                    ...(f.status === 'fulfilled' ? f.value : []),
                ].map((p) => ({
                    code: p.code,
                    direction: p.direction,
                    quantity: p.quantity,
                    unit: 'yd_quantity' in p ? '股' : '口',
                    avg_price: p.price,
                    last_price: p.last_price,
                    pnl: Math.round(p.pnl),
                })),
            };
        }
        case 'get_working_orders': {
            const [s, f] = await Promise.allSettled([
                fetchTrades('S'),
                fetchTrades('F'),
            ]);
            return {
                result: [
                    ...(s.status === 'fulfilled' ? s.value : []),
                    ...(f.status === 'fulfilled' ? f.value : []),
                ]
                    .filter((t) => ACTIVE_ORDER_STATUSES.has(t.status.status))
                    .map((t) => ({
                        order_id: t.order.id,
                        code: t.contract.code,
                        action: t.order.action,
                        price: t.status.modified_price || t.order.price,
                        quantity: t.order.quantity,
                        filled: t.status.deal_quantity,
                        status: t.status.status,
                    })),
            };
        }
        case 'get_account': {
            const [bal, mar] = await Promise.allSettled([
                fetchAccountBalance(),
                fetchMargin(),
            ]);
            return {
                result: {
                    balance:
                        bal.status === 'fulfilled'
                            ? bal.value.acc_balance
                            : null,
                    margin:
                        mar.status === 'fulfilled'
                            ? {
                                  equity: mar.value.equity,
                                  available: mar.value.available_margin,
                                  risk_indicator: mar.value.risk_indicator,
                                  settle_pnl:
                                      mar.value.future_settle_profitloss,
                              }
                            : null,
                },
            };
        }
        case 'get_kbar_summary': {
            const c = await ensureContract(
                String(input.code ?? '').toUpperCase(),
            );
            const days = Math.min(120, Number(input.days) || 20);
            const k = await fetchKbars(
                c,
                dateStrOffset(days),
                dateStrOffset(0),
            );
            const closes = k.Close.filter((v): v is number => !!v);
            if (closes.length === 0) return { result: { error: '無資料' } };
            const highs = k.High.filter((v): v is number => !!v);
            const lows = k.Low.filter((v): v is number => !!v);
            const lastClose = closes[closes.length - 1]!;
            return {
                result: {
                    code: c.code,
                    days,
                    period_high: Math.max(...highs),
                    period_low: Math.min(...lows),
                    last_close: lastClose,
                    period_change_pct: `${(((lastClose - closes[0]!) / closes[0]!) * 100).toFixed(2)}%`,
                },
            };
        }
        case 'get_scanner': {
            const map = {
                change_pct: 'ChangePercentRank',
                volume: 'VolumeRank',
                amount: 'AmountRank',
            } as const;
            const rank =
                map[input.rank as keyof typeof map] ?? 'ChangePercentRank';
            const items = await fetchScanner(
                rank,
                Math.min(30, Number(input.count) || 10),
                true,
            );
            return {
                result: items.map((it) => ({
                    code: it.code,
                    name: it.name,
                    close: it.close,
                    change: it.change_price,
                    volume: it.total_volume,
                    amount: it.total_amount,
                })),
            };
        }
        case 'get_user_activity': {
            const hours = Math.min(72, Number(input.hours) || 24);
            const log = activityLog(hours);
            return {
                result:
                    log.length > 0
                        ? { hours, events: log }
                        : { hours, events: [], note: '期間內沒有記錄到操作' },
            };
        }
        case 'use_skill': {
            const wanted = String(input.name ?? '');
            const skill = findSkill(wanted);
            if (skill) {
                return {
                    result: {
                        name: skill.name,
                        instructions: skill.instructions,
                    },
                };
            }
            const pkg = findPackage(wanted);
            if (pkg) {
                return {
                    result: {
                        name: pkg.name,
                        source: `${pkg.repo}@${pkg.version}`,
                        skill_md: pkg.skillMd,
                        references: pkg.references.map((r) => r.name),
                        note: '需要文件細節時用 read_skill_reference 讀取對應檔案',
                    },
                };
            }
            return { result: { error: `找不到技能 ${wanted}` } };
        }
        case 'read_skill_reference': {
            try {
                const content = await readReference(
                    String(input.skill ?? ''),
                    String(input.file ?? ''),
                );
                return { result: { file: input.file, content } };
            } catch (e) {
                return {
                    result: {
                        error: e instanceof Error ? e.message : String(e),
                    },
                };
            }
        }
        case 'save_skill': {
            const name = String(input.name ?? '').trim();
            if (!name) return { result: { error: '技能名稱不可為空' } };
            const existing = findSkill(name);
            saveSkill({
                id: existing && !existing.builtin ? existing.id : undefined,
                name,
                description: String(input.description ?? '').trim(),
                instructions: String(input.instructions ?? ''),
            });
            notify({
                kind: 'info',
                title: `🤖 Agent ${existing ? '更新' : '學會'}了技能「${name}」`,
                body: String(input.description ?? '').slice(0, 100),
            });
            return { result: { saved: true, name } };
        }
        case 'notify_user': {
            notify({
                kind: 'info',
                title: `🤖 ${String(input.title ?? '')}`,
                body: String(input.body ?? ''),
            });
            return { result: { sent: true } };
        }
        case 'place_order': {
            const proposal: OrderProposal = {
                code: String(input.code ?? '').toUpperCase(),
                action: input.action === 'Sell' ? 'Sell' : 'Buy',
                price:
                    input.price === undefined || input.price === null
                        ? null
                        : Number(input.price),
                quantity: Math.max(1, Number(input.quantity) || 1),
                reason: String(input.reason ?? ''),
            };
            if (policy !== 'auto') {
                return {
                    result: {
                        status: 'awaiting_user_confirmation',
                        note: '提案已顯示，等待使用者手動確認',
                    },
                    proposal,
                };
            }
            // auto: execute through the same risk-gated path as humans
            const contract = await ensureContract(proposal.code);
            const trade = await placeQuickOrder(
                contract,
                proposal.action,
                proposal.price,
                proposal.quantity,
            );
            notify({
                kind: 'ok',
                title: '🤖 Agent 已下單',
                body: `${proposal.code} ${proposal.action === 'Buy' ? '買' : '賣'} ${proposal.quantity} @ ${proposal.price ?? '市價'}（${trade.status.status}）`,
            });
            return {
                result: {
                    status: trade.status.status,
                    order_id: trade.order.id,
                },
            };
        }
        case 'cancel_order': {
            await cancelOrder(String(input.order_id ?? ''));
            return { result: { cancelled: true } };
        }
        default:
            return { result: { error: `unknown tool ${name}` } };
    }
}
