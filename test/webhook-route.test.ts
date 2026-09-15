import { describe, it, expect, vi, beforeAll } from 'vitest';
import { createHmac } from 'node:crypto';

const SECRET = 'sk_test_fixture_key_not_real';
beforeAll(() => { process.env['PAYSTACK_SECRET_KEY'] = SECRET; });

const settlePayment = vi.fn(async () => ({ settled: true, duplicate: false }));
vi.mock('../src/db/client.js', () => ({ pingDb: async () => true, prisma: {} }));
vi.mock('../src/domain/payments.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  settlePayment: (...a: unknown[]) => settlePayment(...(a as [])),
}));

const { buildApp } = await import('../src/app.js');

const post = async (body: string, signature?: string) => {
  const app = buildApp();
  const res = await app.inject({
    method: 'POST',
    url: '/payments/webhook',
    headers: {
      'content-type': 'application/json',
      ...(signature ? { 'x-paystack-signature': signature } : {}),
    },
    payload: body,
  });
  await app.close();
  return res;
};

const sign = (b: string) => createHmac('sha512', SECRET).update(Buffer.from(b, 'utf8')).digest('hex');
const charge = (event = 'charge.success') => JSON.stringify({
  event, data: { id: 12345, reference: 'LTPAY-ABC', amount: 50000, channel: 'card' },
});

describe('POST /payments/webhook', () => {
  it('accepts a correctly signed charge.success', async () => {
    settlePayment.mockClear();
    const body = charge();
    const res = await post(body, sign(body));
    expect(res.statusCode).toBe(200);
    expect(settlePayment).toHaveBeenCalled();
  });

  // 401 and not 400: an unsigned caller is unauthenticated, and Paystack does
  // not retry 4xx, so a forged request is dropped rather than replayed.
  it('rejects an unsigned request with 401 and never settles', async () => {
    settlePayment.mockClear();
    const res = await post(charge());
    expect(res.statusCode).toBe(401);
    expect(settlePayment).not.toHaveBeenCalled();
  });

  it('rejects a wrong signature with 401', async () => {
    settlePayment.mockClear();
    const res = await post(charge(), 'f'.repeat(128));
    expect(res.statusCode).toBe(401);
    expect(settlePayment).not.toHaveBeenCalled();
  });

  it('rejects a body tampered after signing', async () => {
    settlePayment.mockClear();
    const body = charge();
    const res = await post(body.replace('50000', '1'), sign(body));
    expect(res.statusCode).toBe(401);
    expect(settlePayment).not.toHaveBeenCalled();
  });

  // Acknowledged, not errored: a non-2xx makes Paystack retry something we
  // will never process.
  it('acknowledges events it does not handle', async () => {
    settlePayment.mockClear();
    const body = JSON.stringify({ event: 'transfer.success', data: { reference: 'x', amount: 1 } });
    const res = await post(body, sign(body));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ignored: 'transfer.success' });
    expect(settlePayment).not.toHaveBeenCalled();
  });

  it('rejects a signed but unparseable payload with 400', async () => {
    settlePayment.mockClear();
    const body = JSON.stringify({ event: 'charge.success', data: { nope: true } });
    const res = await post(body, sign(body));
    expect(res.statusCode).toBe(400);
    expect(settlePayment).not.toHaveBeenCalled();
  });
});
