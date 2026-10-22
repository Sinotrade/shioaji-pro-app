// src/components/portfolio-sector-panel.tsx — 持股族群 panel: my stock holdings
// grouped by 族群／產業鏈／題材 against the live group flow.
//
// The feed is the one 產業鏈資金流向 uses (chain-feed.tsx): same K-bar batch
// keys, ref-counted, so having both panels open adds no request. 族群 flow
// rides the index_components group metrics shared with 產業全景.

import { AsyncStatus } from './async-status';
import { FeedStatus, useChainFeed } from './chain-feed';
import { PortfolioSector } from './portfolio-sector';
import type { Grouping } from '../lib/portfolio-sector';
import type { HoldingForm } from '../lib/workspace';
import * as panel from './panel.css';
import * as s from './chain-map.css';

export function PortfolioSectorPanel({
    onPick,
    form,
    grouping,
    onFormChange,
    onGroupingChange,
}: {
    onPick?: (code: string) => void;
    /** The panel's own 呈現 / 分組 (saved with the layout); absent = last choice. */
    form?: HoldingForm;
    grouping?: Grouping;
    onFormChange?: (form: HoldingForm) => void;
    onGroupingChange?: (grouping: Grouping) => void;
}) {
    const feed = useChainFeed();
    const { data, ready } = feed;

    if (data.phase === 'loading') {
        return (
            <div className={s.center}>
                <AsyncStatus phase='loading' text='讀取產業鏈資料…' />
            </div>
        );
    }
    if (data.phase === 'error' || !ready) {
        return (
            <div className={s.center}>
                <AsyncStatus
                    phase='error'
                    text={data.phase === 'error' ? data.error : '沒有產業鏈資料'}
                    action={
                        <button type='button' className={panel.btn} onClick={data.retry}>
                            重試
                        </button>
                    }
                />
            </div>
        );
    }

    return (
        <div ref={feed.rootRef} className={s.wrap}>
            <PortfolioSector
                themes={ready.themes}
                book={feed.book}
                revision={feed.revision}
                now={feed.now}
                from={feed.from}
                nameOf={feed.nameOf}
                reducedMotion={feed.reducedMotion}
                paused={feed.paused}
                onPick={onPick ?? noop}
                status={<FeedStatus feed={feed} />}
                form={form}
                grouping={grouping}
                onFormChange={onFormChange}
                onGroupingChange={onGroupingChange}
            />
            <div className={s.footer}>
                <span>
                    淨流入為估算值：族群取自產業指標，產業鏈與題材依每分鐘成交值與漲跌估算。產業鏈與題材為第三方 AI 整理資料（
                    {ready.themesMeta.asOf ?? '--'}），可能過時或有誤
                </span>
            </div>
        </div>
    );
}

function noop() {}
