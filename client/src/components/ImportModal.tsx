import { useState, useRef } from 'react';
import { Upload, FileSpreadsheet, Download, Loader2, CheckCircle, AlertCircle } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import api from '../lib/api';
import { cap } from '../lib/permissions';
import { cn } from '../lib/utils';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { OverlayBody, OverlayFooter, OverlayHeader, ScrollRegion } from './sales/dialog-parts-b';
import { dialogShellClass } from './sales/dialog-classes-b';

interface ImportError {
  row: number;
  message: string;
}

/** COA and party import: what a row does to the opening balance (server routes/import/coa.ts, parties.ts). */
interface OpeningPreview {
  allowed: boolean;
  reason: string | null;
  cutoverDate: string | null;
  recorded: string | null;
  /** 'kept' (parties only): the party has transactions, its opening balance stays. */
  action: 'unchanged' | 'post' | 'replace' | 'kept';
  runningBalance: boolean;
  needsConfirm: boolean;
  /** Parties only: the opening per kind (AR, AP, Supplier or Customer deposit). */
  kinds?: Array<{ kind: 'AR' | 'AP' | 'VDEP' | 'CDEP'; action: 'unchanged' | 'post' | 'replace'; recorded: string | null; amount: string }>;
}

interface PreviewResult {
  data: any[];
  errors: ImportError[];
  total: number;
  /** Journals skipped because the same content was imported before (journals only). */
  alreadyImported?: Array<{ narration: string; date: string }>;
}

interface ImportResult {
  success: number;
  failed: number;
  errors: ImportError[];
  alreadyImported?: Array<{ narration: string; date: string }>;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  importType: 'parties' | 'coa' | 'journals' | 'inventory';
}

/** Dialog title: `shell:importModal.titles.<importType>`. */
const typeConfig = {
  parties: {
    endpoint: '/import/parties',
    columns: ['name', 'partyType', 'phone', 'email', 'address', 'taxId', 'openingBalance', 'arahSaldo', 'depositBalance', 'customerDepositBalance'],
    templateHeaders: 'name,partyType,phone,email,address,taxId,openingBalance,arahSaldo,depositBalance,customerDepositBalance',
    templateSample: 'PT ABC,Customer,081234567890,abc@example.com,Jl. Contoh No.1,1234567890,5000000,Piutang,0,0',
    queryKeys: ['parties', 'coa', 'coa-all', 'balance-sheet', 'trial-balance', 'profit-loss', 'journals', 'dashboard-metrics'],
  },
  coa: {
    endpoint: '/import/coa',
    columns: ['accountNumber', 'name', 'rootType', 'accountType', 'parentNumber', 'isGroup', 'openingBalance'],
    templateHeaders: 'accountNumber,name,rootType,accountType,parentNumber,isGroup,openingBalance',
    templateSample: '1.1.1,Kas,ASSET,ASSET,,false,5000000',
    queryKeys: ['coa', 'coa-all', 'balance-sheet', 'trial-balance', 'profit-loss', 'journals', 'dashboard-metrics'],
  },
  journals: {
    endpoint: '/import/journals',
    columns: ['date', 'narration', 'accountNumber', 'debit', 'credit', 'description', 'ref', 'partyCode'],
    templateHeaders: 'date,narration,accountNumber,debit,credit,description,ref,partyCode',
    templateSample: '22/03/2026,Penjualan tunai,1.1.1,1000000,0,Kas masuk,J-001,\n22/03/2026,Penjualan tunai,4.1,0,1000000,Pendapatan penjualan,J-001,',
    queryKeys: ['journals', 'gl', 'coa', 'coa-all', 'balance-sheet', 'trial-balance', 'profit-loss', 'dashboard-metrics'],
  },
  inventory: {
    endpoint: '/import/inventory',
    columns: ['code', 'name', 'unit', 'category', 'description', 'minimumStock', 'openingQty', 'openingPrice', 'warehouseCode'],
    templateHeaders: 'code,name,unit,category,description,minimumStock,openingQty,openingPrice,warehouseCode',
    templateSample: 'GKP,Gabah Kering Panen,Kg,Bahan Baku,,1000,500,10000,',
    queryKeys: ['inventory-items', 'coa', 'coa-all', 'balance-sheet', 'trial-balance', 'profit-loss', 'journals', 'dashboard-metrics'],
  },
};

const AlreadyImportedNote = ({ items }: { items: Array<{ narration: string; date: string }> }) => {
  const { t } = useTranslation('shell');
  return (
    <div className="rounded-lg bg-muted p-3 text-xs text-muted-foreground">
      <p className="font-semibold">{t('importModal.alreadyImported', { count: items.length })}</p>
      {items.slice(0, 5).map((it, i) => (
        <p key={i}>{it.date} · {it.narration}</p>
      ))}
      {items.length > 5 && <p>{t('importModal.moreErrors', { count: items.length - 5 })}</p>}
    </div>
  );
};

/** "Receivable 2000000.00 → 3000000" for every kind the row replaces (the kind's own recorded and new amount). */
const replacedKinds = (opening: OpeningPreview, kindLabel: (kind: 'AR' | 'AP' | 'VDEP' | 'CDEP') => string): string =>
  (opening.kinds ?? [])
    .filter((k) => k.action === 'replace')
    .map((k) => `${kindLabel(k.kind)} ${k.recorded ?? '—'} → ${k.amount}`)
    .join('; ');

const OpeningCell = ({ value, opening }: { value: unknown; opening?: OpeningPreview | null }) => {
  const { t } = useTranslation('shell');
  const kindLabel = (kind: 'AR' | 'AP' | 'VDEP' | 'CDEP') => t(`importModal.opening.kind.${kind}`);
  if (!opening) return <>{String(value ?? '')}</>;
  const label = opening.reason === 'OPENING_DATE_MISMATCH'
    ? t('importModal.opening.dateMismatch', { date: opening.cutoverDate ?? '—' })
    : !opening.allowed && opening.action !== 'unchanged'
    ? t('importModal.opening.refused')
    : opening.action === 'replace' && opening.kinds
      ? t('importModal.opening.replaceKinds', { changes: replacedKinds(opening, kindLabel) })
      : opening.action === 'replace'
      ? t('importModal.opening.replace', { recorded: opening.recorded ?? '—' })
      : t(`importModal.opening.${opening.action}`);
  return (
    <>
      {String(value ?? '')}
      <span className={cn('block text-[11px]', opening.needsConfirm ? 'text-warning-text' : 'text-muted-foreground')}>
        {label}{opening.runningBalance ? ` · ${t('importModal.opening.runningBalance')}` : ''}
      </span>
    </>
  );
};

/** A COA row (confirmed by its account number) or a party row (confirmed by its sheet row number). */
interface OpeningRow {
  accountNumber?: string;
  rowNum?: number;
  name: string;
  openingBalance: unknown;
  opening?: OpeningPreview | null;
}

const confirmKey = (row: OpeningRow): string => row.accountNumber ?? String(row.rowNum);

/**
 * Every row that needs a confirmation, each with its own checkbox (also rows beyond the 20 shown
 * in the table): ticking one replacement never confirms a running balance on another account.
 */
const OpeningConfirmList = ({ rows, confirmed, onToggle }: { rows: OpeningRow[]; confirmed: string[]; onToggle: (key: string, on: boolean) => void }) => {
  const { t } = useTranslation('shell');
  const kindLabel = (kind: 'AR' | 'AP' | 'VDEP' | 'CDEP') => t(`importModal.opening.kind.${kind}`);
  const forParties = rows.every((row) => row.accountNumber === undefined);
  const title = t(forParties ? 'importModal.confirmPartyTitle' : 'importModal.confirmTitle');
  return (
    <fieldset className="grid gap-1.5 rounded-lg bg-warning-subtle p-3 text-xs text-warning-text">
      <legend className="sr-only">{title}</legend>
      <p className="font-semibold">{title}</p>
      <div className="grid max-h-32 gap-1 overflow-y-auto">
        {rows.map((row) => (
          <label key={confirmKey(row)} className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={confirmed.includes(confirmKey(row))}
              onChange={(e) => onToggle(confirmKey(row), e.target.checked)}
            />
            <span>
              {row.opening?.action === 'replace'
                ? row.accountNumber === undefined
                  ? t('importModal.confirmReplacePartyRow', { row: row.rowNum, name: row.name, changes: replacedKinds(row.opening, kindLabel) })
                  : t('importModal.confirmReplaceRow', { account: row.accountNumber, name: row.name, recorded: row.opening.recorded ?? '—', amount: String(row.openingBalance) })
                : t('importModal.confirmRunningRow', { account: row.accountNumber, name: row.name, amount: String(row.openingBalance) })}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
};

const ImportModal = ({ isOpen, onClose, importType }: Props) => {
  const { t } = useTranslation(['shell', 'common']);
  const [step, setStep] = useState<'upload' | 'preview' | 'result'>('upload');
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [confirmed, setConfirmed] = useState<string[]>([]);
  const [throughLock, setThroughLock] = useState(false);
  const [lockReason, setLockReason] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const config = typeConfig[importType];

  const previewMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append('file', file);
      const res = await api.post(`${config.endpoint}?preview=true`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      return res.data as PreviewResult;
    },
    onSuccess: (data) => {
      setConfirmed([]);
      setPreview(data);
      setStep('preview');
    },
    onError: (err: any) => {
      toast.error(err.response?.data?.error || t('importModal.processFailed'));
    },
  });

  const importMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append('file', file);
      confirmed.forEach((key) => formData.append('confirmReplace', key));
      if (throughLock) formData.append('throughLockReason', lockReason.trim());
      const res = await api.post(config.endpoint, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      return res.data as ImportResult;
    },
    onSuccess: (data) => {
      setResult(data);
      setStep('result');
      config.queryKeys.forEach((key) => queryClient.invalidateQueries({ queryKey: [key] }));
      if (data.success > 0) toast.success(t('importModal.imported', { count: data.success }));
    },
    onError: (err: any) => {
      toast.error(err.response?.data?.error || t('importModal.importFailed'));
    },
  });

  const handleFileSelect = (file: File) => {
    setSelectedFile(file);
    previewMutation.mutate(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFileSelect(file);
  };

  const handleConfirmImport = () => {
    if (selectedFile) importMutation.mutate(selectedFile);
  };

  const downloadTemplate = async () => {
    try {
      const res = await api.get(`/import/template/${importType}`, { responseType: 'blob' });
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const link = document.createElement('a');
      link.href = url;
      link.download = `template_${importType}.xlsx`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch {
      // Fallback to CSV if backend template endpoint not available
      const csvContent = `${config.templateHeaders}\n${config.templateSample}`;
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `template_${importType}.csv`;
      link.click();
      URL.revokeObjectURL(url);
    }
  };

  const handleClose = () => {
    setStep('upload');
    setSelectedFile(null);
    setPreview(null);
    setResult(null);
    setConfirmed([]);
    setThroughLock(false);
    setLockReason('');
    onClose();
  };

  const openingRows: OpeningRow[] = importType === 'coa' || importType === 'parties' ? preview?.data ?? [] : [];
  const confirmRows = openingRows.filter((row) => row.opening?.needsConfirm);
  const toggleConfirm = (key: string, on: boolean) =>
    setConfirmed((list) => (on ? [...list, key] : list.filter((n) => n !== key)));
  // Posting through the period lock (owner decision #10): period.lock holders only, with a reason.
  const canThroughLock = cap('period.lock') && openingRows.some((row) => row.opening?.allowed && row.opening.action !== 'unchanged' && row.opening.action !== 'kept');
  const lockReasonOk = !throughLock || lockReason.trim().length >= 10;
  const STEPS = ['upload', 'preview', 'result'] as const;
  const busy = previewMutation.isPending || importMutation.isPending;
  const stepLabel = t(`importModal.steps.${step}`);

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && !busy && handleClose()}>
      <DialogContent size="lg" className={cn(dialogShellClass, 'lg:max-w-3xl')}>
        <OverlayHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileSpreadsheet className="size-5 text-primary" aria-hidden />
            {t(`importModal.titles.${importType}`)}
          </DialogTitle>
          <DialogDescription className="flex items-center gap-2">
            <span className="flex items-center gap-1" aria-hidden>
              {STEPS.map((s, i) => (
                <span
                  key={s}
                  className={cn(
                    'size-2 rounded-full',
                    step === s ? 'bg-primary' : i <= STEPS.indexOf(step) ? 'bg-primary/40' : 'bg-border',
                  )}
                />
              ))}
            </span>
            {t('importModal.stepOf', { current: STEPS.indexOf(step) + 1, total: STEPS.length, label: stepLabel })}
          </DialogDescription>
        </OverlayHeader>

        <OverlayBody>
          {step === 'upload' && (
            <div className="grid gap-4">
              <button
                type="button"
                onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                disabled={previewMutation.isPending}
                className={cn(
                  'rounded-xl border-2 border-dashed p-10 text-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  isDragging ? 'border-primary bg-primary-subtle' : 'border-border hover:border-primary/50 hover:bg-accent',
                )}
              >
                {previewMutation.isPending ? (
                  <span role="status" className="block">
                    <Loader2 className="mx-auto mb-3 size-8 animate-spin text-primary" aria-hidden />
                    <span className="block text-sm font-medium text-foreground">{t('importModal.processing')}</span>
                  </span>
                ) : (
                  <>
                    <Upload className="mx-auto mb-3 size-8 text-muted-foreground" aria-hidden />
                    <span className="block text-sm font-medium text-foreground">{t('importModal.dropzone')}</span>
                    <span className="mt-1 block text-xs text-muted-foreground">{t('importModal.formats', { size: '5MB' })}</span>
                  </>
                )}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv,.xlsx,.xls"
                className="hidden"
                aria-label={t('importModal.chooseFile')}
                tabIndex={-1}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleFileSelect(file);
                  e.target.value = '';
                }}
              />
              <Button type="button" variant="link" size="sm" className="justify-self-start" onClick={downloadTemplate}>
                <Download aria-hidden /> {t('importModal.downloadTemplate')}
              </Button>
            </div>
          )}

          {step === 'preview' && preview && (
            <div className="grid gap-4">
              <div>
                <p className="text-sm font-medium text-foreground">{selectedFile?.name}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {t('importModal.previewSummary', { valid: preview.data.length, errors: preview.errors.length })}
                </p>
              </div>

              {preview.errors.length > 0 && (
                <div role="alert" className="max-h-32 overflow-y-auto rounded-lg bg-danger-subtle p-3 text-danger-text">
                  <p className="mb-1 text-xs font-semibold">{t('importModal.errorsCount', { count: preview.errors.length })}</p>
                  {preview.errors.slice(0, 10).map((err, i) => (
                    <p key={i} className="text-xs">{t('importModal.rowError', { row: err.row, message: err.message })}</p>
                  ))}
                  {preview.errors.length > 10 && (
                    <p className="mt-1 text-xs">{t('importModal.moreErrors', { count: preview.errors.length - 10 })}</p>
                  )}
                </div>
              )}

              {importType === 'journals' && preview.errors.length > 0 && (
                <p className="text-xs text-muted-foreground">{t('importModal.allOrNothing')}</p>
              )}

              {(preview.alreadyImported?.length ?? 0) > 0 && (
                <AlreadyImportedNote items={preview.alreadyImported!} />
              )}

              {confirmRows.length > 0 && (
                <OpeningConfirmList rows={confirmRows} confirmed={confirmed} onToggle={toggleConfirm} />
              )}

              {canThroughLock && (
                <div className="grid gap-2 text-xs">
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={throughLock} onChange={(e) => setThroughLock(e.target.checked)} />
                    {t('importModal.throughLock')}
                  </label>
                  {throughLock && (
                    <label className="grid gap-1">
                      <span>{t('importModal.lockReason')}</span>
                      <textarea
                        className="rounded-md border border-border bg-background px-2 py-1 text-sm"
                        rows={2}
                        value={lockReason}
                        onChange={(e) => setLockReason(e.target.value)}
                      />
                      <span className="text-muted-foreground">{t('importModal.lockReasonHint')}</span>
                    </label>
                  )}
                </div>
              )}

              {preview.data.length > 0 && (
                <ScrollRegion label={t('importModal.previewLabel')} className="max-h-72 overflow-y-auto border border-border">
                  <table className="w-full text-xs">
                    <thead className="sticky top-0 bg-muted">
                      <tr className="border-b border-border">
                        <th scope="col" className="px-3 py-2 text-left font-medium text-muted-foreground">#</th>
                        {config.columns.map((col) => (
                          <th key={col} scope="col" className="whitespace-nowrap px-3 py-2 text-left font-medium text-muted-foreground">{col}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {preview.data.slice(0, 20).map((row: any, i: number) => (
                        <tr key={i} className="border-b border-border/60">
                          <td className="px-3 py-1.5 text-muted-foreground">{i + 1}</td>
                          {config.columns.map((col) => (
                            <td key={col} className="px-3 py-1.5 text-foreground">
                              {col === 'openingBalance' && (importType === 'coa' || importType === 'parties')
                                ? <OpeningCell value={row[col]} opening={row.opening} />
                                : String(row[col] ?? '')}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {preview.data.length > 20 && (
                    <div className="px-3 py-2 text-center text-xs text-muted-foreground">
                      {t('importModal.showingOf', { shown: 20, total: preview.data.length })}
                    </div>
                  )}
                </ScrollRegion>
              )}
            </div>
          )}

          {step === 'result' && result && (
            <div className="grid gap-4">
              <div className="py-4 text-center" role="status">
                {result.success > 0 ? (
                  <CheckCircle className="mx-auto mb-3 size-10 text-success-text" aria-hidden />
                ) : (
                  <AlertCircle className="mx-auto mb-3 size-10 text-danger-text" aria-hidden />
                )}
                <p className="text-lg font-semibold text-foreground">{t('importModal.done')}</p>
                <div className="mt-2 flex items-center justify-center gap-4">
                  <div>
                    <p className="text-2xl font-bold tabular-nums text-success-text">{result.success}</p>
                    <p className="text-xs text-muted-foreground">{t('importModal.succeeded')}</p>
                  </div>
                  {result.failed > 0 && (
                    <div>
                      <p className="text-2xl font-bold tabular-nums text-danger-text">{result.failed}</p>
                      <p className="text-xs text-muted-foreground">{t('importModal.failed')}</p>
                    </div>
                  )}
                </div>
              </div>

              {(result.alreadyImported?.length ?? 0) > 0 && (
                <AlreadyImportedNote items={result.alreadyImported!} />
              )}

              {result.errors.length > 0 && (
                <div className="max-h-32 overflow-y-auto rounded-lg bg-danger-subtle p-3 text-danger-text">
                  <p className="mb-1 text-xs font-semibold">{t('importModal.errorDetail')}</p>
                  {result.errors.map((err, i) => (
                    <p key={i} className="text-xs">{err.row > 0 ? t('importModal.rowError', { row: err.row, message: err.message }) : err.message}</p>
                  ))}
                </div>
              )}
            </div>
          )}
        </OverlayBody>

        <OverlayFooter>
          {step === 'upload' && (
            <Button type="button" variant="ghost" onClick={handleClose} disabled={previewMutation.isPending}>{t('common:actions.cancel')}</Button>
          )}
          {step === 'preview' && preview && (
            <>
              <Button type="button" variant="ghost" disabled={importMutation.isPending}
                onClick={() => { setStep('upload'); setSelectedFile(null); setPreview(null); setConfirmed([]); }}>
                {t('importModal.changeFile')}
              </Button>
              <Button type="button" onClick={handleConfirmImport}
                disabled={preview.data.length === 0 || (importType === 'journals' && preview.errors.length > 0) || !lockReasonOk} loading={importMutation.isPending}>
                {importMutation.isPending ? t('importModal.importing') : t('importModal.importCount', { count: preview.data.length })}
              </Button>
            </>
          )}
          {step === 'result' && <Button type="button" onClick={handleClose}>{t('common:actions.close')}</Button>}
        </OverlayFooter>
      </DialogContent>
    </Dialog>
  );
};

export default ImportModal;
