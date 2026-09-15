import { randomBytes } from 'node:crypto';
import type { PrismaClient, Payment } from '@prisma/client';
import { buildEnvelope, type PaymentEventPayload } from '../events/envelope.js';

const PRODUCER = 'logitrack-payment-service';

export class NotFoundError extends Error {
  readonly statusCode = 404;
  constructor(ref: string) {
    super(`Payment ${ref} not found`);
    this.name = 'NotFoundError';
  }
}

export class AmountMismatchError extends Error {
  readonly statusCode = 409;
  constructor(expected: number, actual: number) {
    super(`Paystack reported ${actual} but the payment is for ${expected}`);
    this.name = 'AmountMismatchError';
  }
}

export const newReference = (): string => `LTPAY-${randomBytes(8).toString('hex').toUpperCase()}`;

const toPayload = (p: Payment): PaymentEventPayload => ({
  paymentId: p.id,
  reference: p.reference,
  shipmentId: p.shipmentId,
  customerId: p.customerId,
  amount: p.amount,
  currency: p.currency,
  status: p.status,
  channel: p.channel,
});

export async function createPayment(
  db: PrismaClient,
  input: { shipmentId: string; customerId: string; email: string; amount: number; currency: string },
): Promise<Payment> {
  return db.$transaction(async (tx) => {
    const payment = await tx.payment.create({
      data: { ...input, reference: newReference() },
    });
    await tx.outboxEvent.create({
      data: {
        partitionKey: payment.shipmentId,
        eventType: 'payment.initialized',
        envelope: buildEnvelope({
          eventType: 'payment.initialized',
          payload: toPayload(payment),
          producer: PRODUCER,
        }) as object,
      },
    });
    return payment;
  });
}

export interface SettleInput {
  reference: string;
  webhookId: string;
  succeeded: boolean;
  amount: number;
  channel: string | null;
  paidAt: string | null;
  gatewayResponse: string | null;
  paystackId: string | null;
}

export interface SettleResult {
  settled: boolean;
  duplicate: boolean;
  payment?: Payment;
}

// Paystack retries webhooks, so this must be safe to run repeatedly. The
// ProcessedWebhook insert and the settlement share one transaction: a replay
// fails the insert and rolls the settlement back with it.
export async function settlePayment(db: PrismaClient, input: SettleInput): Promise<SettleResult> {
  try {
    return await db.$transaction(async (tx) => {
      await tx.processedWebhook.create({
        data: { id: input.webhookId, event: input.succeeded ? 'success' : 'failed', reference: input.reference },
      });

      const existing = await tx.payment.findUnique({ where: { reference: input.reference } });
      if (!existing) throw new NotFoundError(input.reference);

      // Never trust the amount in the callback alone. A mismatch means either
      // a tampered payload or a reference collision, and settling anyway would
      // mark an underpaid shipment as fully paid.
      if (input.succeeded && input.amount !== existing.amount) {
        throw new AmountMismatchError(existing.amount, input.amount);
      }

      // Terminal payments never move again.
      if (existing.status !== 'PENDING') {
        return { settled: false, duplicate: true, payment: existing };
      }

      const payment = await tx.payment.update({
        where: { reference: input.reference },
        data: {
          status: input.succeeded ? 'SUCCEEDED' : 'FAILED',
          channel: input.channel,
          paystackId: input.paystackId,
          paidAt: input.paidAt ? new Date(input.paidAt) : null,
          failureText: input.succeeded ? null : input.gatewayResponse,
        },
      });

      const eventType = input.succeeded ? 'payment.succeeded' : 'payment.failed';
      await tx.outboxEvent.create({
        data: {
          partitionKey: payment.shipmentId,
          eventType,
          envelope: buildEnvelope({
            eventType,
            payload: toPayload(payment),
            producer: PRODUCER,
          }) as object,
        },
      });

      return { settled: true, duplicate: false, payment };
    });
  } catch (err) {
    if (isUniqueViolation(err)) return { settled: false, duplicate: true };
    throw err;
  }
}

const isUniqueViolation = (err: unknown): boolean =>
  typeof err === 'object' && err !== null && (err as { code?: string }).code === 'P2002';

export async function getByReference(db: PrismaClient, reference: string): Promise<Payment> {
  const p = await db.payment.findUnique({ where: { reference } });
  if (!p) throw new NotFoundError(reference);
  return p;
}

export async function listForShipment(db: PrismaClient, shipmentId: string): Promise<Payment[]> {
  return db.payment.findMany({ where: { shipmentId }, orderBy: { createdAt: 'desc' } });
}
