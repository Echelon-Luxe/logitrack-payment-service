import type { PrismaClient } from '@prisma/client';
import type { EventEnvelope, ShipmentEventPayload } from '../events/envelope.js';

// The driver's cut of what the customer actually paid for the shipment.
// Percent, so it stays exact in integer kobo.
const SHARE_PERCENT = Number(process.env['DRIVER_SHARE_PERCENT'] ?? 80);

// Used when a shipment is picked up with no succeeded payment against it - a
// cash job, or a customer who has not paid yet. The driver still did the work,
// so the earning is recorded rather than skipped.
const FALLBACK_KOBO = Number(process.env['DRIVER_FALLBACK_FEE_KOBO'] ?? 150_000);

export interface ApplyResult {
  readonly applied: boolean;
  readonly duplicate: boolean;
  readonly reason?: string;
}

type Effect = 'ACCRUE' | 'SETTLE' | 'VOID' | 'IGNORE';

const effectFor = (eventType: string): Effect => {
  switch (eventType) {
    case 'shipment.picked_up': return 'ACCRUE';
    case 'shipment.delivered': return 'SETTLE';
    case 'shipment.cancelled': return 'VOID';
    default: return 'IGNORE';
  }
};

/**
 * What the driver earns for this shipment, in kobo.
 *
 * Derived from the customer's payment rather than stored on the shipment: the
 * shipment has no price, and the payment is the only record of what the job was
 * actually worth.
 */
export async function earningAmount(
  db: Pick<PrismaClient, 'payment'>,
  shipmentId: string,
): Promise<{ amount: number; currency: string }> {
  const payment = await db.payment.findFirst({
    where: { shipmentId, status: 'SUCCEEDED' },
    orderBy: { createdAt: 'desc' },
  });

  if (!payment) return { amount: FALLBACK_KOBO, currency: 'NGN' };

  // Integer maths throughout: percent of kobo, floored. A fraction of a kobo
  // cannot be paid, and rounding up would pay out more than was collected.
  return {
    amount: Math.floor((payment.amount * SHARE_PERCENT) / 100),
    currency: payment.currency,
  };
}

/**
 * Applies one shipment event to the earnings ledger. Idempotent: the
 * ProcessedEvent insert fails on replay, and the Earning itself is unique per
 * shipment, so a redelivered pickup cannot pay a driver twice.
 */
export async function applyEarningEvent(
  db: PrismaClient,
  env: EventEnvelope<ShipmentEventPayload>,
): Promise<ApplyResult> {
  const effect = effectFor(env.eventType);
  if (effect === 'IGNORE') return { applied: false, duplicate: false, reason: 'not an earning event' };

  const { shipmentId, driverId } = env.payload;

  // A shipment can be cancelled before anyone picks it up; there is nothing to
  // void and no driver to pay.
  if (effect === 'ACCRUE' && !driverId) {
    return { applied: false, duplicate: false, reason: 'no driver on event' };
  }

  try {
    return await db.$transaction(async (tx) => {
      await tx.processedEvent.create({
        data: { eventId: env.eventId, eventType: env.eventType },
      });

      if (effect === 'ACCRUE') {
        const { amount, currency } = await earningAmount(tx, shipmentId);
        await tx.earning.create({
          data: { shipmentId, driverId: driverId as string, amount, currency },
        });
        return { applied: true, duplicate: false };
      }

      const existing = await tx.earning.findUnique({ where: { shipmentId } });
      if (!existing) return { applied: false, duplicate: false, reason: 'no earning for shipment' };

      // Terminal either way: a settled earning is money already owed, and a
      // voided one was never owed. Neither moves again.
      if (existing.status !== 'PENDING') {
        return { applied: false, duplicate: false, reason: `earning already ${existing.status}` };
      }

      await tx.earning.update({
        where: { shipmentId },
        data: effect === 'SETTLE'
          ? { status: 'PAID', paidAt: new Date() }
          : { status: 'VOID' },
      });
      return { applied: true, duplicate: false };
    });
  } catch (err) {
    // Unique violation on either the ledger or the earning: this event, or this
    // shipment's pickup, has already been handled.
    if (typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002') {
      return { applied: false, duplicate: true };
    }
    throw err;
  }
}
