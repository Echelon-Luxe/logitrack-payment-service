import { buildApp, setReady, SERVICE_NAME } from './app.js';
import { connectProducer, disconnectProducer, startOutboxPublisher, stopOutboxPublisher } from './events/producer.js';
import { pingDb } from './db/client.js';

const PORT = Number(process.env['PORT'] ?? 3006);
const app = buildApp();

async function main(): Promise<void> {
  // Fail fast: without the key every webhook fails signature verification and
  // every payment silently stays PENDING.
  if (!process.env['PAYSTACK_SECRET_KEY']) {
    app.log.error('PAYSTACK_SECRET_KEY is not set');
    process.exit(1);
  }

  await app.listen({ port: PORT, host: '0.0.0.0' });

  if (!(await pingDb())) {
    // Stay up but un-ready rather than crash-loop through a DB outage.
    app.log.error('database unreachable at startup; staying un-ready');
  }

  try {
    await connectProducer();
    startOutboxPublisher();
    app.log.info('kafka producer connected');
  } catch (err) {
    app.log.error({ err }, 'kafka unavailable; events will queue in the outbox');
  }

  setReady(true);
  app.log.info({ service: SERVICE_NAME, port: PORT }, 'service started');
}

let shuttingDown = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    // Fail readiness before closing so the pod leaves Service endpoints first.
    setReady(false);
    stopOutboxPublisher();
    void (async () => {
      await app.close();
      await disconnectProducer();
      process.exit(0);
    })();
  });
}

main().catch((err: unknown) => {
  app.log.error({ err }, 'failed to start');
  process.exit(1);
});
