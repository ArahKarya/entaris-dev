/** Balance-sheet rows in the PDF: their type and their label in the printing language. */
import { pdfT } from './pdfFormat';

export interface BSSection {
  name: string; balance: number; children?: BSSection[];
  /** Row type from the balance-sheet API; synthetic rows are labelled from it, `name` is the fallback. */
  kind?: 'account' | 'retainedEarnings' | 'currentProfit' | 'detail';
  detail?: 'retainedAccount' | 'otherCurrentProfit' | 'unclosedProfit' | 'groupDirect';
}

/** Row label: synthetic balance-sheet rows from `kind` in the printing language, accounts by name. */
export function bsLabel(item: BSSection): string {
  const t = pdfT();
  if (item.kind === 'currentProfit') return t('report.balanceSheet.rows.currentProfit');
  if (item.kind === 'retainedEarnings') return t('report.balanceSheet.rows.retainedEarnings');
  if (item.kind === 'detail' && item.detail) return t(`report.balanceSheet.rows.${item.detail}`);
  return item.name;
}
