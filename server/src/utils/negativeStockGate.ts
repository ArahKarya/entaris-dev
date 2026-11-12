// One rule for every path that lets stock go negative on request (allowNegativeStock): the
// caller needs the inventory.negative_stock capability (Admin by default). doc.cancel or
// approval rights alone are not enough. The reason check (>= 10 characters) stays with each
// route and runs first, so a missing reason is 400 before the 403.

import { hasCap } from '../services/permissionService';

export const NEGATIVE_STOCK_CAP = 'inventory.negative_stock';
/** Error code of the 403 below, so clients and AIRA can tell it from other refusals. */
export const NEGATIVE_STOCK_FORBIDDEN = 'NEGATIVE_STOCK_FORBIDDEN';
/** Same text as the production-run create/edit/draft gates (English entry in i18n/messages/inventory.ts). */
export const NEGATIVE_STOCK_FORBIDDEN_MESSAGE = 'Anda tidak berwenang bypass validasi stok.';

export const negativeStockForbiddenBody = () => ({ error: NEGATIVE_STOCK_FORBIDDEN_MESSAGE, code: NEGATIVE_STOCK_FORBIDDEN });

/** True when the request asks for the bypass and the role does not hold the capability. */
export async function negativeStockBypassDenied(role: string, allowNegativeStock: boolean): Promise<boolean> {
  return allowNegativeStock && !(await hasCap(role, NEGATIVE_STOCK_CAP));
}

/** The bypass a route passes on to a service after the reason and capability checks above. */
export interface NegativeStockBypass {
  allowNegativeStock?: boolean;
  negativeStockReason?: string | null;
}
