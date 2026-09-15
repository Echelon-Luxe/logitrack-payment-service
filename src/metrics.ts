import { Registry, collectDefaultMetrics, Counter, Gauge } from 'prom-client';

export const registry = new Registry();
registry.setDefaultLabels({ service: 'logitrack-payment-service' });
collectDefaultMetrics({ register: registry });

export const paymentsInitialized = new Counter({
  name: 'payments_initialized_total',
  help: 'Payments created and sent to Paystack',
  registers: [registry],
});

export const paymentsSettled = new Counter({
  name: 'payments_settled_total',
  help: 'Payments moved to a terminal state',
  labelNames: ['result'] as const,
  registers: [registry],
});

export const webhooksRejected = new Counter({
  name: 'payment_webhooks_rejected_total',
  help: 'Webhook requests refused before processing',
  labelNames: ['reason'] as const,
  registers: [registry],
});

export const webhooksDuplicate = new Counter({
  name: 'payment_webhooks_duplicate_total',
  help: 'Webhook replays that were no-ops',
  registers: [registry],
});

export const outboxPending = new Gauge({
  name: 'payment_outbox_pending',
  help: 'Payment events awaiting publication',
  registers: [registry],
});

export const httpRequests = new Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [registry],
});
