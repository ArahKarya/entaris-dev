import Decimal from 'decimal.js';
import type { Prisma } from '@prisma/client';
import { BusinessError } from '../utils/errors';

/** Error code: the deposit was partly refunded, so a full cancel would over-reverse it. */
export const DEPOSIT_CANCEL_REFUNDED = 'DEPOSIT_REFUNDED';

/**
 * Reject cancelling a customer or supplier deposit that has a refund. The cancel reverses the full
 * amount, so the deposit account, cash and party balance would end short by the refund.
 */
export function assertDepositNotRefunded(deposit: { refundedAmount: Prisma.Decimal | Decimal | number | string }) {
  if (new Decimal(deposit.refundedAmount.toString()).gt(0)) {
    throw new BusinessError(
      'Uang muka ini sudah di-refund sebagian, jadi tidak bisa dibatalkan. Sisa uang muka tetap bisa dipakai di Invoice atau di-refund.',
      DEPOSIT_CANCEL_REFUNDED,
    );
  }
}
