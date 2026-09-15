import { describe, it, expect, vi } from 'vitest';
import { settlePayment, AmountMismatchError, NotFoundError } from '../src/domain/payments.js';

const payment = (over: Record<string, unknown> = {}) => ({
  id: 'p1', reference: 'LTPAY-ABC', shipmentId: 'ship-1', customerId: 'cust-1',
  email: 'a@b.c', amount: 50000, currency: 'NGN', status: 'PENDING',
  channel: null, paystackId: null, paidAt: null, failureText: null,
  createdAt: new Date(), updatedAt: new Date(), ...over,
});

const makeDb = (opts: { found?: unknown; ledgerThrows?: unknown } = {}) => {
  const create = vi.fn(async () => { if (opts.ledgerThrows) throw opts.ledgerThrows; return {}; });
  const outboxCreate = vi.fn(async () => ({}));
  const update = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...payment(), ...data }));
  const findUnique = vi.fn(async () => ('found' in opts ? opts.found : payment()));
  const tx = {
    processedWebhook: { create },
    payment: { findUnique, update },
    outboxEvent: { create: outboxCreate },
  };
  const db = { $transaction: async (fn: (t: unknown) => unknown) => fn(tx) } as never;
  return { db, create, update, outboxCreate, findUnique };
};

const input = (over: Record<string, unknown> = {}) => ({
  reference: 'LTPAY-ABC', webhookId: 'wh-1', succeeded: true, amount: 50000,
  channel: 'card', paidAt: '2026-09-15T10:00:00.000Z',
  gatewayResponse: 'Successful', paystackId: '12345', ...over,
});

describe('settlePayment', () => {
  it('marks a successful charge SUCCEEDED and emits an event', async () => {
    const { db, update, outboxCreate } = makeDb();
    const r = await settlePayment(db, input());
    expect(r.settled).toBe(true);
    expect((update.mock.calls[0]![0] as { data: { status: string } }).data.status).toBe('SUCCEEDED');
    expect((outboxCreate.mock.calls[0]![0] as { data: { eventType: string } }).data.eventType)
      .toBe('payment.succeeded');
  });

  it('marks a failed charge FAILED and records the gateway reason', async () => {
    const { db, update, outboxCreate } = makeDb();
    await settlePayment(db, input({ succeeded: false, gatewayResponse: 'Insufficient funds' }));
    const data = (update.mock.calls[0]![0] as { data: { status: string; failureText: string } }).data;
    expect(data.status).toBe('FAILED');
    expect(data.failureText).toBe('Insufficient funds');
    expect((outboxCreate.mock.calls[0]![0] as { data: { eventType: string } }).data.eventType)
      .toBe('payment.failed');
  });

  /**
   * The money check. Trusting the callback amount would let a tampered or
   * mismatched payload mark an underpaid shipment as fully paid.
   */
  it('refuses to settle when the amount disagrees', async () => {
    const { db, update } = makeDb();
    let thrown: unknown;
    try { await settlePayment(db, input({ amount: 1 })); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(AmountMismatchError);
    expect((thrown as { statusCode: number }).statusCode).toBe(409);
    expect(update).not.toHaveBeenCalled();
  });

  it('does not amount-check a failed charge', async () => {
    const { db, update } = makeDb();
    await settlePayment(db, input({ succeeded: false, amount: 0 }));
    expect(update).toHaveBeenCalled();
  });

  // Paystack retries webhooks; a replay must not emit a second event.
  it('treats a replayed webhook id as a duplicate', async () => {
    const { db, update } = makeDb({ ledgerThrows: { code: 'P2002' } });
    const r = await settlePayment(db, input());
    expect(r).toEqual({ settled: false, duplicate: true });
    expect(update).not.toHaveBeenCalled();
  });

  // A different webhook id for an already-terminal payment must also be inert.
  it('refuses to move a payment that already settled', async () => {
    const { db, update, outboxCreate } = makeDb({ found: payment({ status: 'SUCCEEDED' }) });
    const r = await settlePayment(db, input({ webhookId: 'wh-2' }));
    expect(r.duplicate).toBe(true);
    expect(update).not.toHaveBeenCalled();
    expect(outboxCreate).not.toHaveBeenCalled();
  });

  it('404s for an unknown reference', async () => {
    const { db } = makeDb({ found: null });
    let thrown: unknown;
    try { await settlePayment(db, input()); } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(NotFoundError);
  });

  it('propagates other database errors so the caller can retry', async () => {
    const { db } = makeDb({ ledgerThrows: new Error('connection terminated') });
    let thrown: unknown;
    try { await settlePayment(db, input()); } catch (e) { thrown = e; }
    expect((thrown as Error).message).toBe('connection terminated');
  });

  it('writes the webhook ledger before mutating, in one transaction', async () => {
    const { db, create, update } = makeDb();
    await settlePayment(db, input());
    expect(create.mock.invocationCallOrder[0]!).toBeLessThan(update.mock.invocationCallOrder[0]!);
  });

  it('partitions the event by shipment so payment order is preserved', async () => {
    const { db, outboxCreate } = makeDb();
    await settlePayment(db, input());
    expect((outboxCreate.mock.calls[0]![0] as { data: { partitionKey: string } }).data.partitionKey)
      .toBe('ship-1');
  });
});
