# logitrack-payment-service

Paystack payments for LogiTrack. Owns the `payments` schema, exposes transaction
initialization and the Paystack webhook, and emits `payment.*` events.

Part of the [LogiTrack](https://github.com/Echelon-Luxe) platform.

## Endpoints

| Path | Purpose |
|---|---|
| `POST /payments/initialize` | Creates a payment and returns a Paystack authorization URL |
| `POST /payments/webhook` | Paystack callback. HMAC SHA512 verified against the raw body |
| `GET /payments/:reference` | Payment status |
| `GET /payments/shipment/:id` | Payments for a shipment |
| `GET /healthz` `/readyz` `/metrics` | Probes and Prometheus metrics |

## Events

`payment.initialized`, `payment.succeeded`, `payment.failed` on
`logitrack.payment.events`, partitioned by `shipmentId`.

## Secrets

`PAYSTACK_SECRET_KEY` is required at startup and the process exits without it.
It never belongs in git - `.env` locally, a Kubernetes Secret in dev, External
Secrets in production.

## Local development

```bash
npm ci
npm run dev
npm test
```
