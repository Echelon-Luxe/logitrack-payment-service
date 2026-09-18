import { describe, it, expect } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { applyEarningEvent, earningAmount } from '../src/domain/earnings.js';
import type { EventEnvelope, ShipmentEventPayload } from '../src/events/envelope.js';

const event = (
  eventType: string,
  over: Partial<ShipmentEventPayload> = {},
): EventEnvelope<ShipmentEventPayload> => ({
  eventId: `evt-${Math.random().toString(36).slice(2)}`,
  eventType,
  eventVersion: 1,
  occurredAt: new Date().toISOString(),
  traceId: 'trace-1',
  producer: 'logitrack-shipment-service',
  payload: {
    shipmentId: '11111111-1111-4111-8111-111111111111',
    reference: 'SHP-1',
    status: 'PICKED_UP',
    customerId: 'cust-1',
    driverId: 'driver-1',
    origin: 'Lagos',
    destination: 'Abuja',
    ...over,
  },
});

/** Minimal Prisma stand-in: records what was written so effects are assertable. */
const fakeDb = (opts: {
  payment?: { amount: number; currency: string } | null;
  earning?: { status: string } | null;
  processedThrows?: boolean;
} = {}) => {
  const writes: Record<string, unknown>[] = [];
  const tx = {
    processedEvent: {
      create: async () => {
        if (opts.processedThrows) throw Object.assign(new Error('dup'), { code: 'P2002' });
        return {};
      },
    },
    payment: { findFirst: async () => opts.payment ?? null },
    earning: {
      create: async ({ data }: { data: Record<string, unknown> }) => { writes.push({ op: 'create', ...data }); return data; },
      findUnique: async () => opts.earning ?? null,
      update: async ({ data }: { data: Record<string, unknown> }) => { writes.push({ op: 'update', ...data }); return data; },
    },
  };
  const db = { $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx) } as unknown as PrismaClient;
  return { db, writes, tx };
};

describe('earningAmount', () => {
  it('takes the configured share of what the customer actually paid', async () => {
    const { tx } = fakeDb({ payment: { amount: 500_000, currency: 'NGN' } });
    // 80% of 5,000.00 NGN
    expect(await earningAmount(tx as never, 'ship-1')).toEqual({ amount: 400_000, currency: 'NGN' });
  });

  // A fraction of a kobo cannot be paid, and rounding up would pay out more
  // than was collected.
  it('floors rather than rounding up', async () => {
    const { tx } = fakeDb({ payment: { amount: 999, currency: 'NGN' } });
    expect((await earningAmount(tx as never, 'ship-1')).amount).toBe(799);
  });

  it('falls back to a flat fee when nothing was paid', async () => {
    const { tx } = fakeDb({ payment: null });
    expect((await earningAmount(tx as never, 'ship-1')).amount).toBe(150_000);
  });
});

describe('applyEarningEvent', () => {
  it('accrues on pickup', async () => {
    const { db, writes } = fakeDb({ payment: { amount: 100_000, currency: 'NGN' } });
    const res = await applyEarningEvent(db, event('shipment.picked_up'));
    expect(res.applied).toBe(true);
    expect(writes[0]).toMatchObject({ op: 'create', driverId: 'driver-1', amount: 80_000 });
  });

  it('settles on delivery', async () => {
    const { db, writes } = fakeDb({ earning: { status: 'PENDING' } });
    const res = await applyEarningEvent(db, event('shipment.delivered'));
    expect(res.applied).toBe(true);
    expect(writes[0]).toMatchObject({ op: 'update', status: 'PAID' });
  });

  it('voids on cancellation', async () => {
    const { db, writes } = fakeDb({ earning: { status: 'PENDING' } });
    const res = await applyEarningEvent(db, event('shipment.cancelled'));
    expect(writes[0]).toMatchObject({ op: 'update', status: 'VOID' });
    expect(res.applied).toBe(true);
  });

  // The whole point of paying on delivery: a cancellation after the money has
  // been settled must not silently reverse a completed payout.
  it('leaves an already paid earning alone', async () => {
    const { db, writes } = fakeDb({ earning: { status: 'PAID' } });
    const res = await applyEarningEvent(db, event('shipment.cancelled'));
    expect(res.applied).toBe(false);
    expect(writes).toHaveLength(0);
  });

  it('treats a redelivered event as a duplicate rather than paying twice', async () => {
    const { db, writes } = fakeDb({ payment: { amount: 100_000, currency: 'NGN' }, processedThrows: true });
    const res = await applyEarningEvent(db, event('shipment.picked_up'));
    expect(res).toEqual({ applied: false, duplicate: true });
    expect(writes).toHaveLength(0);
  });

  it('ignores shipment events that are not about earning', async () => {
    const { db } = fakeDb();
    expect((await applyEarningEvent(db, event('shipment.created'))).applied).toBe(false);
  });

  it('skips a pickup with no driver on it', async () => {
    const { db } = fakeDb();
    const res = await applyEarningEvent(db, event('shipment.picked_up', { driverId: null }));
    expect(res).toMatchObject({ applied: false, reason: 'no driver on event' });
  });
});
