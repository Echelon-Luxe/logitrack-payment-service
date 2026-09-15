import { describe, it, expect, afterEach, vi } from 'vitest';

const pingDb = vi.fn<() => Promise<boolean>>();
vi.mock('../src/db/client.js', () => ({ pingDb: () => pingDb(), prisma: {} }));

const { buildApp, setReady } = await import('../src/app.js');

describe('health endpoints', () => {
  afterEach(() => { setReady(false); pingDb.mockReset(); });

  it('liveness is up even when the database is unreachable', async () => {
    pingDb.mockResolvedValue(false);
    const app = buildApp();
    expect((await app.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
    await app.close();
  });

  it('readiness is 503 before the service marks itself ready', async () => {
    pingDb.mockResolvedValue(true);
    const app = buildApp();
    expect((await app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(503);
    await app.close();
  });

  it('readiness is 200 when ready and the database answers', async () => {
    pingDb.mockResolvedValue(true);
    const app = buildApp();
    setReady(true);
    expect((await app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(200);
    await app.close();
  });

  it('exposes payment metrics', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.body).toContain('payment_webhooks_rejected_total');
    expect(res.body).toContain('payments_settled_total');
    await app.close();
  });
});
