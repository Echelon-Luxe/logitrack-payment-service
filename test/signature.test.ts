import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { isValidSignature } from '../src/domain/signature.js';

const SECRET = 'sk_test_fixture_key_not_real';
const sign = (body: string, secret = SECRET) =>
  createHmac('sha512', secret).update(Buffer.from(body, 'utf8')).digest('hex');

const body = JSON.stringify({ event: 'charge.success', data: { reference: 'LTPAY-ABC', amount: 50000 } });

describe('isValidSignature', () => {
  it('accepts a correctly signed body', () => {
    expect(isValidSignature(body, sign(body), SECRET)).toBe(true);
  });

  it('accepts a Buffer body identically to a string', () => {
    expect(isValidSignature(Buffer.from(body, 'utf8'), sign(body), SECRET)).toBe(true);
  });

  it('rejects a signature made with a different secret', () => {
    expect(isValidSignature(body, sign(body, 'sk_test_other'), SECRET)).toBe(false);
  });

  // The whole point: a forged payload cannot be signed without the key.
  it('rejects a tampered body', () => {
    const tampered = body.replace('50000', '1');
    expect(isValidSignature(tampered, sign(body), SECRET)).toBe(false);
  });

  // Re-serialising parsed JSON reorders keys and drops whitespace, so the
  // digest changes. This is why the raw bytes must be preserved.
  it('rejects a semantically identical body with different key order', () => {
    const reordered = JSON.stringify({ data: { amount: 50000, reference: 'LTPAY-ABC' }, event: 'charge.success' });
    expect(isValidSignature(reordered, sign(body), SECRET)).toBe(false);
  });

  it('rejects a missing signature header', () => {
    expect(isValidSignature(body, undefined, SECRET)).toBe(false);
    expect(isValidSignature(body, '', SECRET)).toBe(false);
  });

  // Without a configured secret every signature would otherwise compare equal
  // to an empty-key HMAC, which an attacker can compute.
  it('rejects when no secret is configured', () => {
    expect(isValidSignature(body, sign(body), '')).toBe(false);
  });

  // timingSafeEqual throws on length mismatch; the guard must return false.
  it('rejects a truncated signature without throwing', () => {
    expect(() => isValidSignature(body, sign(body).slice(0, 40), SECRET)).not.toThrow();
    expect(isValidSignature(body, sign(body).slice(0, 40), SECRET)).toBe(false);
  });

  it('rejects a non-hex signature of the right length', () => {
    expect(isValidSignature(body, 'z'.repeat(128), SECRET)).toBe(false);
  });

  it('handles an empty body', () => {
    expect(isValidSignature('', sign(''), SECRET)).toBe(true);
    expect(isValidSignature('', sign(body), SECRET)).toBe(false);
  });
});
