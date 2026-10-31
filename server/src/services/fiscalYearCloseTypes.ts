// Types of the year-close checklist (services/fiscalYearClose.ts), apart so the check modules can
// import them without importing the registry.
import type { Prisma } from '@prisma/client';

type Tx = Prisma.TransactionClient;

/** At most this many items per check go into a checklist response; `count` is always the full number. */
export const CLOSE_CHECK_ITEM_LIMIT = 50;

export type CloseCheckSeverity = 'block' | 'warn';

/** The fiscal year a check runs for, with its business-day bounds. */
export interface CloseCheckYear {
  id: string;
  name: string;
  startDate: Date;
  endDate: Date;
  /** First and last business day (YYYY-MM-DD). */
  startDay: string;
  endDay: string;
  /** Half-open instant range covering the year: [startDay 00:00, day after endDay 00:00) WIB. */
  gte: Date;
  lt: Date;
}

/** One thing that stands in the way, e.g. a draft invoice or a journal whose ledger rows differ. */
export interface CloseCheckItem {
  /** Stable key, unique within the check; baseline rows match on it. */
  key: string;
  /** Record type, e.g. 'SalesInvoice', 'JournalEntry', 'FiscalYear'. */
  kind: string;
  /** Document number, asset, account role or year name. */
  label: string;
  /** Business day of the record (YYYY-MM-DD), when it has one. */
  date?: string;
  /** Amount involved, two decimals; baseline-aware checks always set it. */
  amount?: string;
  /** Set by the runner: the item is in the baseline with the same amount and does not block. */
  baselined?: boolean;
}

export interface CloseCheckOutcome {
  /** Number of items found; may be larger than `items` when the check caps its list. */
  count: number;
  items: CloseCheckItem[];
}

export interface CloseCheck {
  /** Stable id (kebab-case); clients label the check by it. */
  id: string;
  severity: CloseCheckSeverity;
  /**
   * The check's items may be baselined. Its run() must then return every item (count ===
   * items.length), each with a key and an amount.
   */
  baselineAware?: boolean;
  run(tx: Tx, fy: CloseCheckYear): Promise<CloseCheckOutcome>;
}
