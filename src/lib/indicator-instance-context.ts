import { createContext } from 'react';
import type { IndicatorInstanceService } from './indicator-instance-service';

export const IndicatorInstanceContext = createContext<IndicatorInstanceService | null>(null);
