import React from 'react';
import { Document, Page, View, Text, StyleSheet } from '@react-pdf/renderer';
import { C, F, FOOTER_SPACE } from './theme';
import i18n from '../../i18n';
import { pdfDate, pdfDateShort, pdfMoneyAuto, pdfNum, pdfRpAuto, pdfT, type PdfT } from './pdfFormat';
import { amountInWords } from './amountInWords';
import {
  PdfFooter, PdfHeader, PdfMetaField, PdfMetaRow, PdfPartyBlock, PdfSection, PdfSignatureBlock, PdfTable, PdfTotals,
  type PdfColumn, type PdfCompany, type PdfSignature,
} from './kit';

// Pengajuan Pembayaran (payment voucher) and its Pertanggungjawaban (advance settlement), printed from the
// GET /payment-requests/:id payload. Approver names/dates come from the request history.

const S = StyleSheet.create({
  page: { fontFamily: F.regular, fontSize: 9, color: C.dark, paddingTop: 30, paddingBottom: FOOTER_SPACE, paddingHorizontal: 32 },
  sub: { fontSize: 7.5, color: C.muted, marginTop: 1 },
  para: { fontSize: 8.5, lineHeight: 1.4 },
  words: { fontSize: 8.5, fontFamily: F.oblique, color: C.mid, marginTop: 6 },
  sigDate: { fontSize: 7, color: C.muted, textAlign: 'center' },
  box: { borderWidth: 0.6, borderColor: C.border, borderRadius: 3, padding: 8, marginTop: 10 },
});

type Num = number | string | null | undefined;
const num = (n: Num) => Number(n ?? 0) || 0;

export interface PaymentRequestPDFLine {
  lineNo: number;
  description: string;
  amount: Num;
  expenseDate?: string | null;
  category?: string | null;
  quantity?: Num;
  unitAmount?: Num;
  expenseAccount?: { accountNumber: string; name: string } | null;
}

export interface PaymentRequestPDFHistory {
  action: string;
  fromStatus: string | null;
  toStatus: string | null;
  createdAt: string;
  note?: string | null;
  actor: { fullName: string };
}

export interface PaymentRequestPDFData {
  number: string;
  status: string;
  type: { name: string; kind: string };
  requester: { fullName: string };
  supervisor?: { fullName: string } | null;
  department?: string | null;
  payeeKind: 'EMPLOYEE' | 'VENDOR';
  payeeName: string;
  bankName?: string | null;
  bankAccountNo?: string | null;
  bankAccountHolder?: string | null;
  purpose: string;
  neededBy?: string | null;
  totalAmount: Num;
  directorRole?: string | null;
  createdAt: string;
  submittedAt?: string | null;
  paymentDate?: string | null;
  paymentReference?: string | null;
  cashAccount?: { accountNumber: string; name: string } | null;
  paidBy?: { fullName: string } | null;
  journalEntry?: { entryNumber: string; status: string } | null;
  travelDestination?: string | null;
  travelStartDate?: string | null;
  travelEndDate?: string | null;
  travelParticipants?: string | null;
  settlementStatus?: string | null;
  settlementNote?: string | null;
  settlementSubmittedAt?: string | null;
  settlementDate?: string | null;
  settlementRealized?: Num;
  settlementReference?: string | null;
  settlementSupervisor?: { fullName: string } | null;
  settlementCashAccount?: { accountNumber: string; name: string } | null;
  settlementJournal?: { entryNumber: string; status: string } | null;
  settlementLines?: PaymentRequestPDFLine[];
  lines: PaymentRequestPDFLine[];
  history: PaymentRequestPDFHistory[];
  attachments?: Array<{ fileName: string; scope: 'REQUEST' | 'SETTLEMENT' }>;
}

export interface PaymentRequestPDFProps {
  pr: PaymentRequestPDFData;
  company: PdfCompany;
}

const STATUS_COLOR: Record<string, string> = {
  PAID: C.greenDk,
  APPROVED: C.greenDk,
  SETTLED: C.greenDk,
  REJECTED: C.redDk,
  CANCELLED: C.redDk,
};

const lang = () => i18n.language || 'id';
const account = (a?: { accountNumber: string; name: string } | null) => (a ? `${a.accountNumber} · ${a.name}` : null);

/** Latest history entry matching the predicate (approvals can repeat after a revision). */
const lastOf = (h: PaymentRequestPDFHistory[], pred: (e: PaymentRequestPDFHistory) => boolean) =>
  [...h].filter(pred).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1);

/** Signature cell: name of whoever acted, plus the date. */
function signed(t: PdfT, label: string, entry: PaymentRequestPDFHistory | undefined, fallbackName?: string | null): PdfSignature & { date?: string } {
  return {
    label,
    name: entry?.actor.fullName ?? fallbackName ?? null,
    date: entry ? t('paymentRequest.signedOn', { date: pdfDateShort(entry.createdAt) }) : undefined,
  };
}

const SignatureRow: React.FC<{ sigs: Array<PdfSignature & { date?: string }> }> = ({ sigs }) => (
  <View wrap={false}>
    <PdfSignatureBlock signatures={sigs} />
    <View style={{ flexDirection: 'row', marginTop: 2 }}>
      {sigs.map((s, i) => (
        <Text key={i} style={[S.sigDate, { flex: 1 }]}>{s.date ?? ' '}</Text>
      ))}
    </View>
  </View>
);

const lineColumns = (t: PdfT, amountLabel: string): PdfColumn[] => [
  { key: 'no', label: t('paymentRequest.columns.no'), width: 0.4, align: 'center' },
  { key: 'desc', label: t('paymentRequest.columns.description'), width: 3.4 },
  { key: 'date', label: t('paymentRequest.columns.date'), width: 1.1 },
  { key: 'account', label: t('paymentRequest.columns.account'), width: 2.0 },
  { key: 'amount', label: amountLabel, width: 1.5, align: 'right' },
];

function lineRows(t: PdfT, lines: PaymentRequestPDFLine[]) {
  return lines.map((l, i) => {
    const category = l.category ? t(`paymentRequest.category.${l.category}`, { defaultValue: l.category }) : null;
    const qty = l.quantity != null && l.unitAmount != null && num(l.quantity) > 0
      ? `${pdfNum(l.quantity, 2)} × ${pdfMoneyAuto(l.unitAmount)}`
      : null;
    const sub = [category, qty].filter(Boolean).join(' · ');
    return {
      no: String(i + 1),
      desc: (
        <View>
          <Text style={{ fontSize: 8.5 }}>{l.description}</Text>
          {sub ? <Text style={S.sub}>{sub}</Text> : null}
        </View>
      ),
      date: l.expenseDate ? pdfDateShort(l.expenseDate) : '—',
      account: account(l.expenseAccount) ?? '—',
      amount: pdfMoneyAuto(l.amount),
    };
  });
}

const isAdvance = (kind: string) => kind === 'CASH_ADVANCE' || kind === 'TRAVEL';

const TravelBlock: React.FC<{ t: PdfT; pr: PaymentRequestPDFData }> = ({ t, pr }) => {
  if (!pr.travelDestination && !pr.travelStartDate) return null;
  const period = pr.travelStartDate
    ? `${pdfDate(pr.travelStartDate)}${pr.travelEndDate ? ` – ${pdfDate(pr.travelEndDate)}` : ''}`
    : null;
  return (
    <PdfMetaRow>
      <View style={{ flex: 1 }}>
        <PdfMetaField label={t('paymentRequest.travel.destination')} value={pr.travelDestination} />
      </View>
      <View style={{ flex: 1 }}>
        <PdfMetaField label={t('paymentRequest.travel.period')} value={period} />
      </View>
      <View style={{ flex: 1 }}>
        <PdfMetaField label={t('paymentRequest.travel.participants')} value={pr.travelParticipants} />
      </View>
    </PdfMetaRow>
  );
};

const AttachmentList: React.FC<{ t: PdfT; files: string[] }> = ({ t, files }) =>
  files.length ? (
    <PdfSection title={t('paymentRequest.attachments', { count: files.length })}>
      {files.map((f, i) => (
        <Text key={i} style={S.para}>{`${i + 1}. ${f}`}</Text>
      ))}
    </PdfSection>
  ) : null;

/** Pengajuan Pembayaran voucher. */
export const PaymentRequestPDF: React.FC<PaymentRequestPDFProps> = ({ pr, company }) => {
  const t = pdfT();
  const h = pr.history ?? [];
  const total = num(pr.totalAmount);
  const statusText = t(`paymentRequest.status.${pr.status}`, { defaultValue: pr.status });
  const bank = [pr.bankName, pr.bankAccountNo].filter(Boolean).join(' · ');
  const files = (pr.attachments ?? []).filter((a) => a.scope !== 'SETTLEMENT').map((a) => a.fileName);
  const paid = pr.status === 'PAID' || !!pr.paymentDate;

  const sigs = [
    signed(t, t('paymentRequest.signatures.requester'), lastOf(h, (e) => e.action === 'SUBMIT'), pr.requester.fullName),
    signed(t, t('paymentRequest.signatures.supervisor'), lastOf(h, (e) => e.action === 'APPROVE' && e.fromStatus === 'SUBMITTED'), pr.supervisor?.fullName),
    signed(t, t('paymentRequest.signatures.finance'), lastOf(h, (e) => e.action === 'APPROVE' && e.fromStatus === 'PENDING_FINANCE')),
    signed(t, t('paymentRequest.signatures.director'), lastOf(h, (e) => e.action === 'APPROVE' && e.fromStatus === 'PENDING_DIRECTOR')),
  ];

  return (
    <Document title={t('paymentRequest.docTitle', { number: pr.number })} author={company.name}>
      <Page size="A4" style={S.page} wrap>
        <PdfHeader
          company={company}
          title={t('paymentRequest.title')}
          number={pr.number}
          dateLine={t('common.dateLine', { date: pdfDate(pr.submittedAt ?? pr.createdAt) })}
          extraLines={[pr.type.name]}
          status={statusText}
          statusColor={STATUS_COLOR[pr.status] ?? C.amberDk}
        />

        <PdfMetaRow>
          <PdfPartyBlock
            label={t('paymentRequest.requester')}
            name={pr.requester.fullName}
            lines={[
              pr.department && t('paymentRequest.department', { name: pr.department }),
              pr.supervisor && t('paymentRequest.supervisorLine', { name: pr.supervisor.fullName }),
            ]}
          />
          <PdfPartyBlock
            label={pr.payeeKind === 'VENDOR' ? t('paymentRequest.payeeVendor') : t('paymentRequest.payeeEmployee')}
            name={pr.payeeName}
            lines={[bank || null, pr.bankAccountHolder && t('paymentRequest.accountHolder', { name: pr.bankAccountHolder })]}
          />
          <View style={{ flex: 1 }}>
            <PdfMetaField label={t('paymentRequest.neededBy')} value={pr.neededBy ? pdfDate(pr.neededBy) : null} />
            <PdfMetaField label={t('paymentRequest.total')} value={pdfRpAuto(total)} bold />
          </View>
        </PdfMetaRow>

        <PdfSection title={t('paymentRequest.purpose')}>
          <Text style={S.para}>{pr.purpose}</Text>
        </PdfSection>

        <View style={{ marginTop: 10 }}>
          <TravelBlock t={t} pr={pr} />
        </View>

        <PdfTable columns={lineColumns(t, t('paymentRequest.columns.amount'))} rows={lineRows(t, pr.lines)} />
        <PdfTotals grand={{ label: t('common.total'), value: pdfRpAuto(total) }} />
        <Text style={S.words}>{t('paymentRequest.inWords', { words: amountInWords(total, lang()) })}</Text>

        {isAdvance(pr.type.kind) ? <Text style={[S.sub, { marginTop: 4 }]}>{t('paymentRequest.advanceNote')}</Text> : null}

        {paid ? (
          <View style={S.box} wrap={false}>
            <Text style={{ fontSize: 8.5, fontFamily: F.bold, color: C.greenDk, marginBottom: 4 }}>{t('paymentRequest.payment.title')}</Text>
            <PdfMetaRow gap={12}>
              <View style={{ flex: 1 }}>
                <PdfMetaField label={t('paymentRequest.payment.date')} value={pr.paymentDate ? pdfDate(pr.paymentDate) : null} />
              </View>
              <View style={{ flex: 1.4 }}>
                <PdfMetaField label={t('paymentRequest.payment.source')} value={account(pr.cashAccount)} />
              </View>
              <View style={{ flex: 1 }}>
                <PdfMetaField label={t('paymentRequest.payment.reference')} value={pr.paymentReference} />
              </View>
              <View style={{ flex: 1 }}>
                <PdfMetaField label={t('paymentRequest.payment.journal')} value={pr.journalEntry?.entryNumber} />
                <PdfMetaField label={t('paymentRequest.payment.paidBy')} value={pr.paidBy?.fullName} />
              </View>
            </PdfMetaRow>
          </View>
        ) : null}

        <AttachmentList t={t} files={files} />

        <SignatureRow sigs={sigs} />

        <PdfFooter company={company.name} docRef={pr.number} />
      </Page>
    </Document>
  );
};

/** Pertanggungjawaban (settlement of a cash advance / business travel). */
export const PaymentRequestSettlementPDF: React.FC<PaymentRequestPDFProps> = ({ pr, company }) => {
  const t = pdfT();
  const h = pr.history ?? [];
  const advance = num(pr.totalAmount);
  const lines = pr.settlementLines ?? [];
  const realized = pr.settlementRealized != null ? num(pr.settlementRealized) : lines.reduce((s, l) => s + num(l.amount), 0);
  const diff = realized - advance;
  const files = (pr.attachments ?? []).filter((a) => a.scope === 'SETTLEMENT').map((a) => a.fileName);
  const st = pr.settlementStatus ?? 'OPEN';
  const statusText = t(`paymentRequest.settlementStatus.${st}`, { defaultValue: st });
  const diffLabel = diff < 0 ? t('paymentRequest.settlement.return') : diff > 0 ? t('paymentRequest.settlement.reimburse') : t('paymentRequest.settlement.exact');
  const posted = st === 'SETTLED';

  const sigs = [
    signed(t, t('paymentRequest.signatures.requester'), lastOf(h, (e) => e.action === 'SETTLE_SUBMIT'), pr.requester.fullName),
    signed(t, t('paymentRequest.signatures.supervisor'), lastOf(h, (e) => e.action === 'SETTLE_APPROVE'), pr.settlementSupervisor?.fullName ?? pr.supervisor?.fullName),
    signed(t, t('paymentRequest.signatures.finance'), lastOf(h, (e) => e.action === 'SETTLE_POST')),
  ];

  return (
    <Document title={t('paymentRequest.settlementDocTitle', { number: pr.number })} author={company.name}>
      <Page size="A4" style={S.page} wrap>
        <PdfHeader
          company={company}
          title={t('paymentRequest.settlementTitle')}
          number={pr.number}
          dateLine={t('common.dateLine', { date: pdfDate(pr.settlementDate ?? pr.settlementSubmittedAt ?? pr.paymentDate ?? pr.createdAt) })}
          extraLines={[pr.type.name]}
          status={statusText}
          statusColor={STATUS_COLOR[st] ?? C.amberDk}
        />

        <PdfMetaRow>
          <PdfPartyBlock
            label={t('paymentRequest.requester')}
            name={pr.requester.fullName}
            lines={[pr.department && t('paymentRequest.department', { name: pr.department })]}
          />
          <View style={{ flex: 1 }}>
            <PdfMetaField label={t('paymentRequest.settlement.advancePaid')} value={pr.paymentDate ? pdfDate(pr.paymentDate) : null} />
            <PdfMetaField label={t('paymentRequest.payment.journal')} value={pr.journalEntry?.entryNumber} />
          </View>
          <View style={{ flex: 1 }}>
            <PdfMetaField label={t('paymentRequest.settlement.advance')} value={pdfRpAuto(advance)} bold />
          </View>
        </PdfMetaRow>

        <PdfSection title={t('paymentRequest.purpose')}>
          <Text style={S.para}>{pr.purpose}</Text>
        </PdfSection>

        <View style={{ marginTop: 10 }}>
          <TravelBlock t={t} pr={pr} />
        </View>

        <PdfTable
          columns={lineColumns(t, t('paymentRequest.columns.realized'))}
          rows={lineRows(t, lines)}
          emptyText={t('paymentRequest.settlement.empty')}
        />
        <PdfTotals
          rows={[
            { label: t('paymentRequest.settlement.advance'), value: pdfMoneyAuto(advance) },
            { label: t('paymentRequest.settlement.realized'), value: pdfMoneyAuto(realized) },
          ]}
          grand={{ label: diffLabel, value: pdfRpAuto(Math.abs(diff)) }}
          width={260}
        />

        {pr.settlementNote ? (
          <PdfSection title={t('common.notes')}>
            <Text style={S.para}>{pr.settlementNote}</Text>
          </PdfSection>
        ) : null}

        {posted ? (
          <View style={S.box} wrap={false}>
            <Text style={{ fontSize: 8.5, fontFamily: F.bold, color: C.greenDk, marginBottom: 4 }}>{t('paymentRequest.settlement.postedTitle')}</Text>
            <PdfMetaRow gap={12}>
              <View style={{ flex: 1 }}>
                <PdfMetaField label={t('paymentRequest.payment.date')} value={pr.settlementDate ? pdfDate(pr.settlementDate) : null} />
              </View>
              <View style={{ flex: 1.4 }}>
                <PdfMetaField label={t('paymentRequest.settlement.cash')} value={account(pr.settlementCashAccount)} />
              </View>
              <View style={{ flex: 1 }}>
                <PdfMetaField label={t('paymentRequest.payment.reference')} value={pr.settlementReference} />
              </View>
              <View style={{ flex: 1 }}>
                <PdfMetaField label={t('paymentRequest.payment.journal')} value={pr.settlementJournal?.entryNumber} />
              </View>
            </PdfMetaRow>
          </View>
        ) : null}

        <AttachmentList t={t} files={files} />

        <SignatureRow sigs={sigs} />

        <PdfFooter company={company.name} docRef={`${pr.number} · ${t('paymentRequest.settlementShort')}`} />
      </Page>
    </Document>
  );
};

export default PaymentRequestPDF;
