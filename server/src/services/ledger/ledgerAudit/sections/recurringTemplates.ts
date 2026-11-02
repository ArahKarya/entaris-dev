// Active recurring templates that would not pass today's rules: journal lines that fail the one
// line validator, accounts that are group / inactive / control / tax, a party on a line, a next run
// date in the past, or template data whose shape does not fit the template type (E7-R5).

import { businessDayOf, businessToday } from '../../../../utils/businessDate';
import { validateJournalLines, type JournalLineInput } from '../../../../utils/journalLineRules';
import { TEMPLATE_RULE, loadControlAccountMap, postableAccountProblem, type AccountLite } from '../../accountGuard';
import type { AuditRow, AuditSection } from '../types';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Template data that is shaped like a journal: a narration and lines with an accountId. */
function looksLikeJournal(data: Record<string, unknown>): boolean {
  const items = data.items;
  return typeof data.narration === 'string' && Array.isArray(items) && items.length > 0 && items.every((i) => isRecord(i) && 'accountId' in i);
}

const ACCOUNT_CAUSES: Readonly<Record<string, string>> = {
  ACCOUNT_NOT_FOUND: 'account-missing',
  ACCOUNT_GROUP: 'account-group',
  ACCOUNT_INACTIVE: 'account-inactive',
  ACCOUNT_CONTROL: 'account-control-or-tax',
  ACCOUNT_ROOT_TYPE: 'account-root-type',
};

export const recurringTemplatesSection: AuditSection = {
  id: 'recurringTemplates',
  title: 'Active recurring templates that break the journal rules',
  gate: null,
  async run(tx) {
    const templates = await tx.recurringTemplate.findMany({
      where: { isActive: true },
      orderBy: [{ nextRunDate: 'asc' }, { name: 'asc' }],
    });
    const today = businessToday();
    const journalItems = (data: unknown): unknown[] => (isRecord(data) && Array.isArray(data.items) ? data.items : []);
    const accountIds = new Set<string>();
    for (const t of templates) {
      if (t.templateType !== 'journal') continue;
      for (const item of journalItems(t.templateData)) {
        if (isRecord(item) && typeof item.accountId === 'string') accountIds.add(item.accountId);
      }
    }
    const [accounts, control] = await Promise.all([
      tx.account.findMany({
        where: { id: { in: [...accountIds] } },
        select: { id: true, accountNumber: true, name: true, rootType: true, isGroup: true, isActive: true },
      }),
      loadControlAccountMap(tx, TEMPLATE_RULE.alsoRestrict),
    ]);
    const accountById = new Map<string, AccountLite>(accounts.map((a) => [a.id, a]));

    const out: AuditRow[] = [];
    for (const t of templates) {
      const add = (cause: string, detail: string) =>
        out.push({
          section: 'recurringTemplates',
          cause,
          key: `${t.id}:${cause}`,
          label: t.name,
          date: businessDayOf(t.nextRunDate),
          amount: null,
          count: 1,
          yearClosed: null,
          gate: false,
          detail: `${t.templateType}, ${t.frequency}; ${detail}`,
        });
      const data = t.templateData;
      if (businessDayOf(t.nextRunDate) < today) add('next-run-in-past', `next run ${businessDayOf(t.nextRunDate)} is before ${today}`);

      if (t.templateType !== 'journal') {
        if (isRecord(data) && looksLikeJournal(data)) add('type-data-mismatch', 'template data is shaped like a journal');
        continue;
      }
      if (!isRecord(data) || !Array.isArray(data.items)) {
        add('type-data-mismatch', 'journal template without a list of lines');
        continue;
      }
      if (!looksLikeJournal(data) && data.items.every((i) => isRecord(i) && 'itemName' in i)) {
        add('type-data-mismatch', 'journal template with invoice-shaped lines');
        continue;
      }
      const lines: JournalLineInput[] = data.items.map((raw): JournalLineInput => {
        const i = isRecord(raw) ? raw : {};
        return {
          accountId: typeof i.accountId === 'string' ? i.accountId : '',
          debit: i.debit as JournalLineInput['debit'],
          credit: i.credit as JournalLineInput['credit'],
          partyId: typeof i.partyId === 'string' ? i.partyId : null,
        };
      });
      const result = validateJournalLines(lines);
      if (!result.ok) {
        for (const issue of result.issues) {
          add(issue.code === 'JOURNAL_UNBALANCED' ? 'unbalanced' : 'invalid-lines', `${issue.code}${issue.index === null ? '' : ` on line ${issue.index + 1}`}`);
        }
      }
      const reported = new Set<string>();
      for (const line of lines) {
        const problem = postableAccountProblem(accountById.get(line.accountId) ?? null, TEMPLATE_RULE, control.get(line.accountId) ?? null);
        const cause = problem ? (ACCOUNT_CAUSES[problem.code] ?? 'account-problem') : null;
        if (cause && !reported.has(`${cause}:${line.accountId}`)) {
          reported.add(`${cause}:${line.accountId}`);
          const acc = accountById.get(line.accountId);
          add(cause, `account ${acc ? `${acc.accountNumber} ${acc.name}` : line.accountId}`);
        }
      }
      if (lines.some((l) => l.partyId)) add('has-party', 'a line carries a party');
    }
    return out;
  },
};
