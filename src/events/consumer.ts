import { Kafka, type Consumer, logLevel } from 'kafkajs';
import { prisma } from '../db/client.js';
import { applyEarningEvent } from '../domain/earnings.js';
import {
  SHIPMENT_EVENTS_TOPIC,
  CONSUMER_GROUP,
  type EventEnvelope,
  type ShipmentEventPayload,
} from './envelope.js';
import { earningsAccrued, earningsSettled, earningEventsDuplicate } from '../metrics.js';

const brokers = (process.env['KAFKA_BROKERS'] ?? 'localhost:9092').split(',');

const kafka = new Kafka({
  clientId: 'logitrack-payment-service',
  brokers,
  logLevel: logLevel.ERROR,
  retry: { initialRetryTime: 300, retries: 8 },
});

let consumer: Consumer | null = null;
let running = false;

export const isConsumerRunning = (): boolean => running;

const isShipmentEvent = (v: unknown): v is EventEnvelope<ShipmentEventPayload> => {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Record<string, unknown>;
  const p = e['payload'];
  return typeof e['eventId'] === 'string'
    && typeof e['eventType'] === 'string'
    && typeof p === 'object' && p !== null
    && typeof (p as Record<string, unknown>)['shipmentId'] === 'string';
};

export async function startConsumer(): Promise<void> {
  consumer = kafka.consumer({ groupId: CONSUMER_GROUP });
  await consumer.connect();

  // fromBeginning so a fresh deployment rebuilds the ledger from history rather
  // than starting blind. Replay is safe - every effect is idempotent.
  await consumer.subscribe({ topic: SHIPMENT_EVENTS_TOPIC, fromBeginning: true });

  await consumer.run({
    eachMessage: async ({ message }) => {
      const raw = message.value?.toString();
      if (!raw) return;

      let envelope: unknown;
      try {
        envelope = JSON.parse(raw);
      } catch {
        // Unparseable: skipping beats stalling the partition forever. The
        // shipment is still in the database; only the earning is missed.
        return;
      }
      if (!isShipmentEvent(envelope)) return;

      const result = await applyEarningEvent(prisma, envelope);

      if (result.duplicate) {
        earningEventsDuplicate.inc();
        return;
      }
      if (!result.applied) return;

      if (envelope.eventType === 'shipment.picked_up') earningsAccrued.inc();
      if (envelope.eventType === 'shipment.delivered') earningsSettled.inc({ status: 'PAID' });
      if (envelope.eventType === 'shipment.cancelled') earningsSettled.inc({ status: 'VOID' });
    },
  });

  running = true;
}

export async function stopConsumer(): Promise<void> {
  running = false;
  if (consumer) {
    await consumer.disconnect();
    consumer = null;
  }
}
