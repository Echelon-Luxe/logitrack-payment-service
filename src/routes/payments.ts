import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import { paystack } from '../domain/paystack.js';
import { isValidSignature } from '../domain/signature.js';
import { createPayment, settlePayment, getByReference, listForShipment } from '../domain/payments.js';
import { paymentsInitialized, paymentsSettled, webhooksRejected, webhooksDuplicate } from '../metrics.js';

const InitBody = z.object({
  shipmentId: z.string().uuid(),
  customerId: z.string().min(1),
  email: z.string().email(),
  // Kobo/cents. Integer only - floats lose precision on money.
  amount: z.number().int().positive(),
  currency: z.string().length(3).default('NGN'),
});

const WebhookBody = z.object({
  event: z.string(),
  data: z.object({
    id: z.union([z.number(), z.string()]).optional(),
    reference: z.string().min(1),
    amount: z.number().int(),
    channel: z.string().nullable().optional(),
    paid_at: z.string().nullable().optional(),
    gateway_response: z.string().nullable().optional(),
  }),
});

export async function paymentRoutes(app: FastifyInstance): Promise<void> {
  app.post('/payments/initialize', async (req, reply) => {
    const body = InitBody.parse(req.body);
    const payment = await createPayment(prisma, body);
    const init = await paystack.initialize({
      email: body.email,
      amount: body.amount,
      reference: payment.reference,
      currency: body.currency,
      ...(process.env['PAYSTACK_CALLBACK_URL'] ? { callbackUrl: process.env['PAYSTACK_CALLBACK_URL'] } : {}),
    });
    paymentsInitialized.inc();
    return reply.code(201).send({
      reference: payment.reference,
      authorizationUrl: init.authorizationUrl,
      accessCode: init.accessCode,
      amount: payment.amount,
      currency: payment.currency,
    });
  });

  app.post('/payments/webhook', async (req, reply) => {
    const raw = (req as { rawBody?: Buffer }).rawBody;
    if (!raw) {
      webhooksRejected.inc({ reason: 'no_raw_body' });
      return reply.code(400).send({ error: 'BadRequest' });
    }

    const secret = process.env['PAYSTACK_SECRET_KEY'] ?? '';
    if (!isValidSignature(raw, req.headers['x-paystack-signature'] as string | undefined, secret)) {
      webhooksRejected.inc({ reason: 'bad_signature' });
      // 401, not 400: an unsigned caller is unauthenticated, and Paystack does
      // not retry on 4xx, so a forged request is dropped rather than replayed.
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const parsed = WebhookBody.safeParse(req.body);
    if (!parsed.success) {
      webhooksRejected.inc({ reason: 'unparseable' });
      return reply.code(400).send({ error: 'BadRequest' });
    }

    const { event, data } = parsed.data;
    if (!event.startsWith('charge.')) {
      // Acknowledge events we do not handle; a non-2xx makes Paystack retry
      // something we will never process.
      return reply.code(200).send({ ignored: event });
    }

    const result = await settlePayment(prisma, {
      reference: data.reference,
      webhookId: String(data.id ?? `${event}:${data.reference}`),
      succeeded: event === 'charge.success',
      amount: data.amount,
      channel: data.channel ?? null,
      paidAt: data.paid_at ?? null,
      gatewayResponse: data.gateway_response ?? null,
      paystackId: data.id !== undefined ? String(data.id) : null,
    });

    if (result.duplicate) webhooksDuplicate.inc();
    else paymentsSettled.inc({ result: event === 'charge.success' ? 'succeeded' : 'failed' });

    return reply.code(200).send({ received: true });
  });

  app.get('/payments/:reference', async (req) => {
    const { reference } = z.object({ reference: z.string().min(1) }).parse(req.params);
    return getByReference(prisma, reference);
  });

  app.get('/payments/shipment/:shipmentId', async (req) => {
    const { shipmentId } = z.object({ shipmentId: z.string().uuid() }).parse(req.params);
    return listForShipment(prisma, shipmentId);
  });
}
