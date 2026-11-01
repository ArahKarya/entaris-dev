// Source guard (E4-R1): after an invoice is created, only services/salesInvoiceStatus.ts writes a
// sales invoice's outstanding or status, so the status always follows the outstanding. A writer
// added elsewhere (a new payment or deposit service, a repair) must call
// setSalesInvoiceOutstandingInTx instead. Checks the source text with the TypeScript AST: a
// salesInvoice.update / updateMany / upsert, or a claimCancel on tx.salesInvoice, whose `data`
// holds `outstanding` or `status` (or cannot be read statically), and raw `UPDATE sales_invoices`.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';

const SRC = join(__dirname, '../..');

/**
 * Files allowed to write those keys, with the reason. Prefixes end in '/'.
 * routes/settings/dummyData.ts goes once the legacy dummy generator is removed (PR-3.12).
 */
const ALLOWED: Record<string, string> = {
  'services/salesInvoiceStatus.ts': 'the single writer',
  'services/invoiceCancellation.ts': 'claimCancel writes the final Cancelled state with outstanding 0',
  'services/salesInvoiceSubmit.ts': 'creates the invoice (outstanding = grand total)',
  'routes/settings/dummyData.ts': 'legacy dev dummy-data generator',
  'services/demoData/': 'demo data generator',
};

const KEYS = new Set(['outstanding', 'status']);
const WRITE_METHODS = new Set(['update', 'updateMany', 'upsert']);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__' && entry.name !== 'node_modules' && entry.name !== 'generated') out.push(...sourceFiles(full));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

const propName = (p: ts.ObjectLiteralElementLike, sf: ts.SourceFile): string | null =>
  p.name ? p.name.getText(sf).replace(/['"]/g, '') : null;

/** True when an object literal sets one of KEYS, or spreads something that might. */
function literalTouches(obj: ts.ObjectLiteralExpression, sf: ts.SourceFile): boolean {
  return obj.properties.some((p) => ts.isSpreadAssignment(p) || KEYS.has(propName(p, sf) ?? ''));
}

/** `data` given as a variable: its initializer, or any later `name.outstanding =` / `name.status =`. */
function identifierTouches(id: ts.Identifier, sf: ts.SourceFile, text: string): boolean {
  const name = id.text;
  if (new RegExp(`\\b${name}\\.(outstanding|status)\\s*=`).test(text)) return true;
  let found: boolean | null = null;
  const visit = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer) {
      found = ts.isObjectLiteralExpression(n.initializer) ? literalTouches(n.initializer, sf) : true;
    }
    if (found === null) ts.forEachChild(n, visit);
  };
  visit(sf);
  return found ?? true;
}

function dataTouches(data: ts.Expression | undefined, sf: ts.SourceFile, text: string): boolean {
  if (!data) return false;
  if (ts.isObjectLiteralExpression(data)) return literalTouches(data, sf);
  if (ts.isIdentifier(data)) return identifierTouches(data, sf, text);
  return true;
}

function dataOf(arg: ts.Expression | undefined, sf: ts.SourceFile): ts.Expression | undefined {
  if (!arg || !ts.isObjectLiteralExpression(arg)) return arg;
  const p = arg.properties.find((x) => propName(x, sf) === 'data');
  if (!p) return undefined;
  if (ts.isPropertyAssignment(p)) return p.initializer;
  if (ts.isShorthandPropertyAssignment(p)) return p.name;
  return arg;
}

const isSalesInvoiceDelegate = (e: ts.Expression) => ts.isPropertyAccessExpression(e) && e.name.text === 'salesInvoice';

/** Line numbers of writes to a sales invoice's outstanding or status in `text`. */
function findOutstandingWriters(file: string, text: string): number[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lines: number[] = [];
  const at = (n: ts.Node) => lines.push(sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1);
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      if (ts.isPropertyAccessExpression(callee) && WRITE_METHODS.has(callee.name.text) && isSalesInvoiceDelegate(callee.expression)) {
        const arg = n.arguments[0];
        const touches = callee.name.text === 'upsert' || dataTouches(dataOf(arg, sf), sf, text);
        if (touches) at(n);
      }
      if (ts.isIdentifier(callee) && /^(try)?[cC]laimCancel$/.test(callee.text) && n.arguments[0] && isSalesInvoiceDelegate(n.arguments[0])) {
        if (dataTouches(n.arguments[2], sf, text)) at(n);
      }
    }
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n))
      && /update\s+"?sales_invoices"?/i.test(n.text)) {
      at(n);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return lines;
}

const allowed = (rel: string) => Object.keys(ALLOWED).some((k) => (k.endsWith('/') ? rel.startsWith(k) : rel === k));

describe('sales invoice outstanding / status writers', () => {
  it('only the allowed files write them', () => {
    const offenders: string[] = [];
    for (const full of sourceFiles(SRC)) {
      const rel = relative(SRC, full).split(sep).join('/');
      if (allowed(rel)) continue;
      for (const line of findOutstandingWriters(rel, readFileSync(full, 'utf8'))) offenders.push(`${rel}:${line}`);
    }
    expect(offenders, 'Use setSalesInvoiceOutstandingInTx (services/salesInvoiceStatus.ts)').toEqual([]);
  });

  it('every allowlist entry still exists', () => {
    const files = sourceFiles(SRC).map((f) => relative(SRC, f).split(sep).join('/'));
    for (const k of Object.keys(ALLOWED)) {
      expect(files.some((f) => (k.endsWith('/') ? f.startsWith(k) : f === k)), k).toBe(true);
    }
  });

  it('lets a metadata-only edit through (routes/sales.ts PUT /:id)', () => {
    const text = readFileSync(join(SRC, 'routes/sales.ts'), 'utf8');
    expect(text).toContain('prisma.salesInvoice.update({ where: { id: invoice.id }, data })');
    expect(findOutstandingWriters('routes/sales.ts', text)).toEqual([]);
  });

  it('catches each kind of writer', () => {
    const src = [
      "await tx.salesInvoice.update({ where: { id }, data: { outstanding: 0 } });",
      "await tx.salesInvoice.updateMany({ where: { id }, data: { status: 'Paid' } });",
      "await tx.salesInvoice.update({ where: { id }, data: { ...patch } });",
      "const d = { status: 'Paid' }; await tx.salesInvoice.update({ where: { id }, data: d });",
      "const e: any = {}; e.outstanding = 1; await tx.salesInvoice.update({ where: { id }, data: e });",
      "await claimCancel(tx.salesInvoice, id, { status: 'Cancelled', outstanding: 0 });",
      'await tx.$executeRaw`UPDATE sales_invoices SET outstanding = 0 WHERE id = ${id}`;',
      "await tx.salesInvoice.update({ where: { id }, data: { notes: 'x' } });",
    ].join('\n');
    expect(findOutstandingWriters('x.ts', src)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});
