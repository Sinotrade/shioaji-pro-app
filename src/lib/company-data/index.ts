// src/lib/company-data/index.ts — the App-wide shioaji-data reader.
//
// The company panel (#337) and the Agent tools (#338) both use `companyData`,
// so a file fetched for one is reused by the other (same memory and
// IndexedDB cache, one manifest check per TTL).

import { createCompanyDataClient } from './client';
import { createCompanyDataTools } from './agent';

export * from './client';
export * from './queries';
export * from './agent';
export type * from './types';

export const companyData = createCompanyDataClient();
export const companyDataTools = createCompanyDataTools(companyData);
