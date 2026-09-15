import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Paystack signs the RAW request body with HMAC SHA512 using the secret key.
 *
 * Two mistakes make this check worthless while still appearing to work:
 * re-serialising the parsed JSON (key order and whitespace differ, so the
 * digest never matches), and comparing with === (leaks the expected digest
 * byte-by-byte through response timing).
 */
export function isValidSignature(rawBody: Buffer | string, signature: string | undefined, secret: string): boolean {
  if (!signature || !secret) return false;

  const expected = createHmac('sha512', secret)
    .update(typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody)
    .digest('hex');

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  // timingSafeEqual throws on a length mismatch, so guard first.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
