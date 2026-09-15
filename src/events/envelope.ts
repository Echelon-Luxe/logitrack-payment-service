import { randomUUID } from 'node:crypto';

export interface EventEnvelope<T = unknown> {
  eventId: string;
  eventType: string;
  eventVersion: number;
  occurredAt: string;
  traceId: string;
  producer: string;
  payload: T;
}

export interface PaymentEventPayload {
  paymentId: string;
  reference: string;
  shipmentId: string;
  customerId: string;
  amount: number;
  currency: string;
  status: string;
  channel: string | null;
}

export function buildEnvelope<T>(args: {
  eventType: string;
  payload: T;
  producer: string;
  traceId?: string;
  eventVersion?: number;
}): EventEnvelope<T> {
  return {
    eventId: randomUUID(),
    eventType: args.eventType,
    eventVersion: args.eventVersion ?? 1,
    occurredAt: new Date().toISOString(),
    traceId: args.traceId ?? randomUUID(),
    producer: args.producer,
    payload: args.payload,
  };
}

export const PAYMENT_EVENTS_TOPIC = 'logitrack.payment.events';
