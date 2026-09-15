import { z } from 'zod';

const BASE_URL = process.env['PAYSTACK_BASE_URL'] ?? 'https://api.paystack.co';

export class PaystackError extends Error {
  constructor(message: string, readonly statusCode = 502) {
    super(message);
    this.name = 'PaystackError';
  }
}

const InitializeResponse = z.object({
  status: z.boolean(),
  message: z.string(),
  data: z.object({
    authorization_url: z.string().url(),
    access_code: z.string(),
    reference: z.string(),
  }),
});

const VerifyResponse = z.object({
  status: z.boolean(),
  data: z.object({
    id: z.number().optional(),
    status: z.string(),
    reference: z.string(),
    amount: z.number(),
    currency: z.string().optional(),
    channel: z.string().nullable().optional(),
    paid_at: z.string().nullable().optional(),
    gateway_response: z.string().nullable().optional(),
  }),
});

export interface PaystackClient {
  initialize(input: { email: string; amount: number; reference: string; currency: string; callbackUrl?: string }):
    Promise<{ authorizationUrl: string; accessCode: string }>;
  verify(reference: string): Promise<{
    status: string; amount: number; channel: string | null;
    paidAt: string | null; gatewayResponse: string | null; paystackId: string | null;
  }>;
}

const secret = (): string => {
  const key = process.env['PAYSTACK_SECRET_KEY'];
  if (!key) throw new PaystackError('PAYSTACK_SECRET_KEY is not set', 500);
  return key;
};

async function call(path: string, init: RequestInit): Promise<unknown> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${secret()}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(15_000),
  });
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (body as { message?: string }).message ?? `Paystack returned ${res.status}`;
    // 4xx from Paystack is our mistake and will not fix itself on retry;
    // 5xx is theirs and might.
    throw new PaystackError(msg, res.status >= 500 ? 502 : 400);
  }
  return body;
}

export const paystack: PaystackClient = {
  async initialize(input) {
    const body = await call('/transaction/initialize', {
      method: 'POST',
      body: JSON.stringify({
        email: input.email,
        amount: input.amount,
        reference: input.reference,
        currency: input.currency,
        ...(input.callbackUrl ? { callback_url: input.callbackUrl } : {}),
      }),
    });
    const parsed = InitializeResponse.safeParse(body);
    if (!parsed.success) throw new PaystackError('unexpected initialize response shape');
    return {
      authorizationUrl: parsed.data.data.authorization_url,
      accessCode: parsed.data.data.access_code,
    };
  },

  async verify(reference) {
    const body = await call(`/transaction/verify/${encodeURIComponent(reference)}`, { method: 'GET' });
    const parsed = VerifyResponse.safeParse(body);
    if (!parsed.success) throw new PaystackError('unexpected verify response shape');
    const d = parsed.data.data;
    return {
      status: d.status,
      amount: d.amount,
      channel: d.channel ?? null,
      paidAt: d.paid_at ?? null,
      gatewayResponse: d.gateway_response ?? null,
      paystackId: d.id ? String(d.id) : null,
    };
  },
};
