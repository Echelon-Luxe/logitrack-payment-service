import Fastify, { type FastifyInstance } from 'fastify';
import { registry, httpRequests } from './metrics.js';
import { paymentRoutes } from './routes/payments.js';
import { registerErrorHandler } from './errors.js';
import { pingDb } from './db/client.js';

export const SERVICE_NAME = 'logitrack-payment-service';

let ready = false;
export const setReady = (v: boolean): void => { ready = v; };

export function buildApp(): FastifyInstance {
  const app = Fastify({
    logger: { level: process.env['LOG_LEVEL'] ?? 'info' },
    trustProxy: true,
  });

  // Keep the raw bytes: the webhook signature is an HMAC of the body exactly as
  // sent, so re-serialising the parsed object would never match. Done with a
  // content-type parser rather than a preParsing hook - reading the stream in a
  // hook consumes it, leaving the body parser nothing and hanging the request.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    const raw = body as Buffer;
    (req as { rawBody?: Buffer }).rawBody = raw;
    try {
      done(null, raw.length ? JSON.parse(raw.toString('utf8')) : {});
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  app.addHook('onResponse', (req, reply, done) => {
    httpRequests.inc({
      method: req.method,
      route: req.routeOptions.url ?? 'unknown',
      status: String(reply.statusCode),
    });
    done();
  });

  // Never checks dependencies: failing liveness kills the container.
  app.get('/healthz', () => ({ status: 'ok', service: SERVICE_NAME }));

  app.get('/readyz', async (_req, reply) => {
    if (!ready) return reply.code(503).send({ status: 'not-ready', service: SERVICE_NAME });
    const db = await pingDb();
    if (!db) return reply.code(503).send({ status: 'not-ready', service: SERVICE_NAME, db: false });
    return { status: 'ready', service: SERVICE_NAME, db: true };
  });

  app.get('/metrics', async (_req, reply) => {
    reply.header('Content-Type', registry.contentType);
    return registry.metrics();
  });

  registerErrorHandler(app);
  void app.register(paymentRoutes);

  return app;
}
