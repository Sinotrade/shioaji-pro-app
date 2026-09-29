// Market Replay control bar: date picker, transport, speed, seek (research only).
import { Pause, Play, SkipBack, SkipForward, X } from 'lucide-react';
import {
    REPLAY_SPEEDS,
    type MarketReplay,
} from '../hooks/use-market-replay';
import * as s from './replay-controls.css';

const p2 = (n: number) => String(n).padStart(2, '0');
function hhmm(t: number): string {
    if (!t) return '--:--';
    const d = new Date(t * 1000);
    return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
}

export function ReplayControls({ replay }: { replay: MarketReplay }) {
    const { status } = replay;
    const ready = status === 'ready';
    return (
        <div className={s.bar}>
            <button className={`${s.btn} ${s.iconBtn}`} onClick={replay.prevDay}
                title="前一交易日" disabled={!ready && status === 'loading'}>
                <SkipBack size={13} />
            </button>
            <input
                type="date"
                className={s.dateInput}
                value={replay.date}
                max={new Date().toISOString().slice(0, 10)}
                onChange={(e) => e.target.value && replay.setDate(e.target.value)}
                aria-label="回放日期"
            />
            <button className={`${s.btn} ${s.iconBtn}`} onClick={replay.nextDay}
                title="後一交易日">
                <SkipForward size={13} />
            </button>
            <span className={s.divider} />
            <button
                className={`${s.btn} ${replay.playing ? s.btnActive : ''}`}
                onClick={replay.togglePlay}
                disabled={!ready}
                title={replay.playing ? '暫停' : '播放'}
            >
                {replay.playing ? <Pause size={13} /> : <Play size={13} />}
                {replay.playing ? '暫停' : '播放'}
            </button>
            {REPLAY_SPEEDS.map((sp) => (
                <button
                    key={sp}
                    className={`${s.btn} ${replay.speed === sp ? s.btnActive : ''}`}
                    onClick={() => replay.setSpeed(sp)}
                    title={`回放速度 ${sp}x`}
                >
                    {sp}x
                </button>
            ))}
            <input
                type="range"
                className={s.range}
                min={replay.dayStart}
                max={replay.dayEnd}
                step={1}
                value={replay.visibleTime}
                onChange={(e) => replay.seek(Number(e.target.value))}
                aria-label="回放進度"
                disabled={!ready}
            />
            <span className={s.timeText}>
                {hhmm(replay.visibleTime)} / {hhmm(replay.dayEnd)}
            </span>
            <span className={s.divider} />
            <button className={`${s.btn} ${s.iconBtn}`} onClick={replay.disable}
                title="結束回放，回到即時研究">
                <X size={13} />
            </button>
            {status === 'loading' && (
                <span className={s.statusText}>載入 K 棒／Tick…</span>
            )}
            {status === 'error' && (
                <span className={s.errText}>{replay.error || '資料載入失敗'}</span>
            )}
        </div>
    );
}
