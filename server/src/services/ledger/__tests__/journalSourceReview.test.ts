import { describe, it, expect } from 'vitest';
import { parseReviewedSourceCsv, planReviewedRows } from '../journalSourceReview';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

const HEADER = 'id,entry_number,date,status,is_dummy,narration,source_type,source_key,confidence,reason,applied,approved_type';

describe('parseReviewedSourceCsv', () => {
  it('keeps only rows whose approved_type is filled', () => {
    const csv = [
      HEADER,
      `${A},JV-202603-0001,2026-03-01,Submitted,false,Sewa,MANUAL,,low,generic,false,MANUAL`,
      `${B},JV-202603-0002,2026-03-02,Submitted,false,"Bayar, listrik",MANUAL,,low,generic,false,`,
      `${C},JV-202603-0003,2026-03-03,Submitted,false,Gaji,RECURRING,,medium,template,false,  system_doc `,
    ].join('\n');
    expect(parseReviewedSourceCsv(csv)).toEqual({
      rows: [
        { id: A, type: 'MANUAL', line: 2 },
        { id: C, type: 'SYSTEM_DOC', line: 4 },
      ],
      blank: 1,
      errors: [],
    });
  });

  it('rejects a value that is not a journal source type, with its line', () => {
    const csv = [HEADER, `${A},JV-1,2026-03-01,Submitted,false,x,MANUAL,,low,r,false,MANUL`].join('\n');
    const out = parseReviewedSourceCsv(csv);
    expect(out.rows).toEqual([]);
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]).toMatch(/line 2.*MANUL/);
  });

  it('rejects an id that is not a UUID and a journal reviewed twice with different types', () => {
    const csv = [
      'id,approved_type',
      'JV-202603-0001,MANUAL',
      `${A},MANUAL`,
      `${A},IMPORT`,
      `${B},CASH_BOOK`,
      `${B},CASH_BOOK`,
    ].join('\n');
    const out = parseReviewedSourceCsv(csv);
    expect(out.errors).toEqual([
      expect.stringMatching(/line 2.*id/),
      expect.stringMatching(/line 4.*MANUAL.*IMPORT/),
    ]);
    // The duplicate with the same type is harmless and kept once.
    expect(out.rows).toEqual([{ id: A, type: 'MANUAL', line: 3 }, { id: B, type: 'CASH_BOOK', line: 5 }]);
  });

  it('fails when the id or approved_type column is missing', () => {
    expect(parseReviewedSourceCsv(`id,source_type\n${A},MANUAL`).errors[0]).toMatch(/approved_type/);
    expect(parseReviewedSourceCsv(`approved_type\nMANUAL`).errors[0]).toMatch(/"id"/);
  });

  it('reads a semicolon-separated file (spreadsheet saved with an Indonesian locale)', () => {
    const csv = `\uFEFFid;narration;approved_type\r\n${A};Sewa, kantor;IMPORT\r\n`;
    expect(parseReviewedSourceCsv(csv)).toEqual({ rows: [{ id: A, type: 'IMPORT', line: 2 }], blank: 0, errors: [] });
  });
});

describe('planReviewedRows', () => {
  it('applies only journals that exist and are still untagged', () => {
    const rows = [
      { id: A, type: 'MANUAL' as const, line: 2 },
      { id: B, type: 'IMPORT' as const, line: 3 },
      { id: C, type: 'CASH_BOOK' as const, line: 4 },
    ];
    const current = new Map([[A, null], [B, 'SYSTEM_DOC' as const]]);
    expect(planReviewedRows(rows, current)).toEqual({
      apply: [rows[0]],
      alreadyTagged: [{ ...rows[1], current: 'SYSTEM_DOC' }],
      notFound: [rows[2]],
    });
  });
});
