import { useDisplayBook } from '../hooks/use-display-book';
import { displayDayRange } from '../lib/display-day-range';
import type { ContractInfo } from '../lib/types/contract';
import type { Snapshot } from '../lib/types/market';

export function ChartDayRange({contract, snapshot: supplied}: {contract: ContractInfo; snapshot?: Snapshot}) {
    const {quote, snapshot} = useDisplayBook(contract.code, supplied, contract);
    const range = displayDayRange(contract.code, contract.target_code, snapshot, contract.security_type === 'IND' ? quote?.index : quote?.tick);
    const fmt = (value: number) => value.toLocaleString('zh-TW', {maximumFractionDigits: 2});
    return <span style={{display:'inline-flex',gap:7,marginLeft:8,fontSize:10.5,fontWeight:600}}
        title={range ? `${range.source}行情高低｜${new Date(range.time).toLocaleString('zh-TW', {timeZone:'Asia/Taipei'})}｜非平均K高低` : '行情高低資料待確認'}>
        <span style={{color:'#fb7185'}}>高 {range ? fmt(range.high) : '—'}</span>
        <span style={{color:'#4ade80'}}>低 {range ? fmt(range.low) : '—'}</span>
    </span>;
}
