import React, { useState, useEffect, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '../lib/api';
import { AlertCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { NumberInput } from '@/components/ui/number-input';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DateInput, Field, type ComboboxOption } from '@/components/shared';
import {
  FormError,
  PinnedBody,
  PinnedFooter,
  PinnedHeader,
  pinnedDialogClass,
} from '@/components/overlays/dialog-parts';
import { ComboboxField } from '@/components/overlays/ComboboxField';
import { WarehouseSelectField } from '@/components/overlays/WarehouseSelectField';
import { useTranslation } from 'react-i18next';
import { formatNumber } from '@/lib/format';
import { todayLocal } from '@/lib/date';
import { isProductionLinkedMovement } from '@/components/inventory/inventory-rows';

interface StockMovementModalProps {
  isOpen: boolean;
  onClose: () => void;
  editMovement?: any | null;
}

const today = () => todayLocal();

const defaultForm = {
  date: today(),
  itemId: '',
  warehouseId: '',
  movementType: 'In' as 'In' | 'Out' | 'AdjustmentIn' | 'AdjustmentOut',
  quantity: '',
  unitCost: '',
  offsetAccountId: '',
  referenceNumber: '',
  notes: '',
};

export function StockMovementModal({ isOpen, onClose, editMovement }: StockMovementModalProps) {
  const { t } = useTranslation('inventory');
  const [form, setForm] = useState({ ...defaultForm, date: today() });
  const [error, setError] = useState('');
  const [showErrors, setShowErrors] = useState(false);
  const queryClient = useQueryClient();
  const isEdit = !!editMovement;

  // Reset form on open / populate when editing
  useEffect(() => {
    if (isOpen) {
      if (editMovement) {
        setForm({
          date: editMovement.date ? new Date(editMovement.date).toISOString().split('T')[0] : today(),
          itemId: editMovement.itemId || '',
          warehouseId: editMovement.warehouseId || '',
          movementType: editMovement.movementType || 'In',
          quantity: editMovement.quantity != null ? String(Number(editMovement.quantity)) : '',
          unitCost: editMovement.unitCost != null ? String(Number(editMovement.unitCost)) : '',
          offsetAccountId: editMovement.offsetAccountId || '',
          referenceNumber: editMovement.referenceNumber || '',
          notes: editMovement.notes || '',
        });
      } else {
        setForm({ ...defaultForm, date: today() });
      }
      setError('');
      setShowErrors(false);
    }
  }, [isOpen, editMovement]);

  // A stored offset an edit would refuse (a legacy row posted against 3.1 Ekuitas Saldo Awal) is
  // treated as empty and named in the hint, instead of failing the save with ACCOUNT_CONTROL.
  const { data: editDetail } = useQuery({
    queryKey: ['stock-movement', editMovement?.id],
    queryFn: () => api.get(`/inventory/movements/${editMovement?.id}`).then(r => r.data),
    enabled: isOpen && isEdit,
  });
  const staleOffset = isEdit && editDetail?.offsetAllowed === false ? editDetail.offsetAccount : null;
  const offsetAccountId = staleOffset && form.offsetAccountId === staleOffset.id ? '' : form.offsetAccountId;

  // Sertakan warehouseId supaya currentStock tiap item = stok di gudang yang
  // dipilih (bukan total). Tanpa gudang terpilih → tampil total seperti biasa.
  const { data: itemsRaw } = useQuery({
    queryKey: ['inventory-items-active', form.warehouseId],
    queryFn: () =>
      api.get('/inventory/items', {
        params: { isActive: 'true', ...(form.warehouseId ? { warehouseId: form.warehouseId } : {}) },
      }).then(r => r.data.data ?? r.data),
    enabled: isOpen,
  });
  const items: any[] = useMemo(() => itemsRaw ?? [], [itemsRaw]);

  const { data: coaData } = useQuery({
    queryKey: ['coa-flat'],
    queryFn: () => api.get('/coa/flat').then(r => r.data),
    enabled: isOpen,
  });
  const nonGroupAccounts = (coaData ?? []).filter((a: any) => !a.isGroup);

  const selectedItem = items.find((i: any) => i.id === form.itemId);

  const itemOptions = useMemo((): ComboboxOption[] =>
    items.map((i: any) => ({ value: i.id, label: `${i.code} · ${i.name} (${i.unit})` })),
    [items],
  );

  const accountOptions = useMemo((): ComboboxOption[] =>
    nonGroupAccounts.map((a: any) => ({ value: a.id, label: `${a.accountNumber} · ${a.name}` })),
    [nonGroupAccounts],
  );

  // A stock out is valued at the system average on the server (E3-R4); the cost typed in is
  // only sent for a stock in, which needs a cost above 0 and an offset account.
  const inbound = form.movementType === 'In' || form.movementType === 'AdjustmentIn';
  const qty = Number(form.quantity) || 0;
  const unitCost = Number(form.unitCost) || 0;
  const averageCost = Number(selectedItem?.averageCost ?? 0);
  const totalValue = qty * (inbound ? unitCost : averageCost);

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ['stock-movements'] });
    queryClient.invalidateQueries({ queryKey: ['stock-movement'] });
    queryClient.invalidateQueries({ queryKey: ['inventory-items'] });
    queryClient.invalidateQueries({ queryKey: ['inventory-items-active'] });
    queryClient.invalidateQueries({ queryKey: ['coa'] });
    queryClient.invalidateQueries({ queryKey: ['journals'] });
  };

  const createMutation = useMutation({
    mutationFn: (data: any) => api.post('/inventory/movements', data),
    onSuccess: () => {
      invalidateAll();
      toast.success(t('stockMovementModal.toast.created'));
      onClose();
    },
    onError: (err: any) => {
      const msg = err.response?.data?.error || t('stockMovementModal.toast.createFailed');
      setError(msg);
      toast.error(msg);
    },
  });

  const updateMutation = useMutation({
    mutationFn: (data: any) => api.put(`/inventory/movements/${editMovement?.id}`, data),
    onSuccess: () => {
      invalidateAll();
      toast.success(t('stockMovementModal.toast.updated'));
      onClose();
    },
    onError: (err: any) => {
      const msg = err.response?.data?.error || t('stockMovementModal.toast.updateFailed');
      setError(msg);
      toast.error(msg);
    },
  });

  const mutation = isEdit ? updateMutation : createMutation;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    // Same constraints the native `required` / `min` attributes enforced before.
    if (!form.date || !(Number(form.quantity) >= 0.001) || (inbound && (unitCost <= 0 || !offsetAccountId))) {
      setShowErrors(true);
      return;
    }

    const payload: any = {
      date: form.date,
      movementType: form.movementType,
      quantity: Number(form.quantity),
      ...(inbound ? { unitCost } : {}),
      offsetAccountId: offsetAccountId || undefined,
      referenceNumber: form.referenceNumber || undefined,
      notes: form.notes || undefined,
    };

    if (!isEdit) {
      payload.itemId = form.itemId;
      payload.warehouseId = form.warehouseId || undefined;
    }

    mutation.mutate(payload);
  };

  const isProductionLinked = isProductionLinkedMovement(editMovement);
  const pending = mutation.isPending;
  const stockItem = selectedItem || editMovement?.item;
  const dateError = showErrors && !form.date ? t('stockMovementModal.errors.dateRequired') : undefined;
  const qtyError = showErrors && !(Number(form.quantity) >= 0.001) ? t('stockMovementModal.errors.quantityMin') : undefined;
  const unitCostError = showErrors && inbound && unitCost <= 0 ? t('stockMovementModal.errors.unitCostRequired') : undefined;
  const offsetError = showErrors && inbound && !offsetAccountId ? t('stockMovementModal.errors.offsetRequired') : undefined;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && !pending && onClose()}>
      <DialogContent size="md" className={pinnedDialogClass}>
        <form onSubmit={handleSubmit} noValidate className="flex min-h-0 flex-1 flex-col">
          <PinnedHeader>
            <DialogTitle>{isEdit ? t('stockMovementModal.titleEdit') : t('stockMovementModal.titleCreate')}</DialogTitle>
            <DialogDescription>
              {t('stockMovementModal.description')}
            </DialogDescription>
          </PinnedHeader>
          <PinnedBody className="grid gap-4">
            {isProductionLinked && (
              <p role="status" className="flex items-center gap-2 rounded-md bg-warning-subtle px-3 py-2 text-sm text-warning-text">
                <AlertCircle className="size-4 shrink-0" aria-hidden />
                {t('stockMovementModal.productionLinked')}
              </p>
            )}

            <Field label={t('stockMovementModal.fields.date')} required error={dateError}>
              <DateInput
                value={form.date}
                onChange={(v) => setForm(f => ({ ...f, date: v }))}
                disabled={isProductionLinked}
              />
            </Field>

            {isEdit ? (
              <Field label={t('stockMovementModal.fields.item')} required>
                <Input
                  readOnly
                  value={editMovement?.item ? `${editMovement.item.code} · ${editMovement.item.name} (${editMovement.item.unit})` : ''}
                  className="bg-muted"
                />
              </Field>
            ) : (
              <ComboboxField
                label={t('stockMovementModal.fields.item')}
                required
                options={itemOptions}
                value={form.itemId}
                onChange={(v) => setForm(f => ({ ...f, itemId: v }))}
                placeholder={t('stockMovementModal.placeholders.item')}
              />
            )}

            {isEdit ? (
              <Field label={t('stockMovementModal.fields.warehouse')} hint={t('stockMovementModal.hints.warehouseLocked')}>
                <Input readOnly value={editMovement?.warehouse?.name ?? '—'} className="bg-muted" />
              </Field>
            ) : (
              <WarehouseSelectField
                value={form.warehouseId}
                onChange={(v) => setForm(f => ({ ...f, warehouseId: v }))}
                autoDefault
              />
            )}

            <Field label={t('stockMovementModal.fields.movementType')} required>
              {(control) => (
                <Select
                  value={form.movementType}
                  onValueChange={(v) => setForm(f => ({ ...f, movementType: v as typeof form.movementType }))}
                  disabled={isProductionLinked}
                >
                  <SelectTrigger {...control}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="In">{t('stockMovementModal.types.in')}</SelectItem>
                    <SelectItem value="Out">{t('stockMovementModal.types.out')}</SelectItem>
                    <SelectItem value="AdjustmentIn">{t('stockMovementModal.types.adjustmentIn')}</SelectItem>
                    <SelectItem value="AdjustmentOut">{t('stockMovementModal.types.adjustmentOut')}</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label={t('stockMovementModal.fields.quantity')}
                required
                error={qtyError}
                hint={
                  stockItem
                    ? t(!isEdit && form.warehouseId ? 'stockMovementModal.hints.stockInWarehouse' : 'stockMovementModal.hints.stockCurrent', {
                        qty: formatNumber(Number(stockItem.currentStock ?? 0), { maxDecimals: 3 }),
                        unit: stockItem.unit ?? '',
                      })
                    : undefined
                }
              >
                <NumberInput
                  min={0.001}
                  step="any"
                  value={form.quantity}
                  onChange={e => setForm(f => ({ ...f, quantity: e.target.value }))}
                  disabled={isProductionLinked}
                  placeholder="0"
                  className="h-10 text-right tabular-nums"
                />
              </Field>
              {inbound ? (
                <Field label={t('stockMovementModal.fields.unitCost')} required error={unitCostError}>
                  <NumberInput
                    min={0}
                    step="any"
                    value={form.unitCost}
                    onChange={e => setForm(f => ({ ...f, unitCost: e.target.value }))}
                    disabled={isProductionLinked}
                    placeholder="0"
                    className="h-10 text-right tabular-nums"
                  />
                </Field>
              ) : (
                <Field label={t('stockMovementModal.fields.unitCostAverage')} hint={t('stockMovementModal.hints.averageCost')}>
                  <Input
                    readOnly
                    value={selectedItem ? formatNumber(averageCost, { maxDecimals: 2 }) : '—'}
                    className="bg-muted text-right tabular-nums"
                  />
                </Field>
              )}
            </div>

            <Field label={t('stockMovementModal.fields.totalValue')}>
              <Input
                readOnly
                value={formatNumber(totalValue, { decimals: 0 })}
                className="bg-muted text-right tabular-nums"
              />
            </Field>

            <ComboboxField
              label={inbound ? t('stockMovementModal.fields.offsetAccount') : t('stockMovementModal.fields.offsetAccountVariance')}
              required={inbound}
              options={accountOptions}
              value={offsetAccountId}
              onChange={(v) => setForm(f => ({ ...f, offsetAccountId: v }))}
              placeholder={t('stockMovementModal.placeholders.offsetAccount')}
              disabled={isProductionLinked}
              error={offsetError}
              hint={
                staleOffset && !offsetAccountId
                  ? t('stockMovementModal.hints.offsetNoLongerAllowed', { account: `${staleOffset.accountNumber} · ${staleOffset.name}` })
                  : inbound ? t('stockMovementModal.hints.offsetRequired') : t('stockMovementModal.hints.offsetVariance')
              }
            />

            {/* Free text only: the document reference (and its lock) is set by the documents themselves. */}
            <Field label={t('stockMovementModal.fields.referenceNumber')}>
              <Input
                value={form.referenceNumber}
                onChange={e => setForm(f => ({ ...f, referenceNumber: e.target.value }))}
                disabled={isProductionLinked}
                placeholder={t('stockMovementModal.placeholders.referenceNumber')}
              />
            </Field>

            <Field label={t('stockMovementModal.fields.notes')}>
              <Textarea
                rows={3}
                value={form.notes}
                onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                disabled={isProductionLinked}
                placeholder={t('stockMovementModal.placeholders.notes')}
                className="resize-none"
              />
            </Field>

            <FormError message={error} />
          </PinnedBody>
          <PinnedFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>
              {t('stockMovementModal.actions.cancel')}
            </Button>
            {!isProductionLinked && (
              <Button type="submit" loading={pending}>
                {pending ? t('stockMovementModal.actions.saving') : isEdit ? t('stockMovementModal.actions.saveChanges') : t('stockMovementModal.actions.save')}
              </Button>
            )}
          </PinnedFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
