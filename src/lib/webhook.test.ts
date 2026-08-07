/**
 * Webhook verification tests. Signs a payload with the exact scheme the scoring
 * API uses (HMAC-SHA256 over `${ts}.${rawBody}`) via Node crypto, then verifies
 * it through the SDK — proving the two sides agree. No network.
 */

import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyWebhookSignature, constructWebhookEvent } from './webhook.js';

const SECRET = 'whsec_test_123';

function sign(secret: string, ts: number, body: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
}

const event = { id: 'evt_1', type: 'score.band_changed', createdAt: '2026-07-18T00:00:00.000Z', data: { score: 82 } };
const body = JSON.stringify(event);
const now = 1_700_000_000;

describe('verifyWebhookSignature', () => {
  it('accepts a correctly signed, fresh delivery', async () => {
    const r = await verifyWebhookSignature({ secret: SECRET, rawBody: body, signatureHeader: sign(SECRET, now, body), timestampHeader: String(now), nowSeconds: now });
    expect(r.valid).toBe(true);
  });

  it('rejects a tampered body', async () => {
    const r = await verifyWebhookSignature({ secret: SECRET, rawBody: body + ' ', signatureHeader: sign(SECRET, now, body), timestampHeader: String(now), nowSeconds: now });
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/signature mismatch/);
  });

  it('rejects the wrong secret', async () => {
    const r = await verifyWebhookSignature({ secret: 'whsec_other', rawBody: body, signatureHeader: sign(SECRET, now, body), timestampHeader: String(now), nowSeconds: now });
    expect(r.valid).toBe(false);
  });

  it('rejects a stale timestamp (replay) but allows it when tolerance is disabled', async () => {
    const old = now - 10_000;
    const sig = sign(SECRET, old, body);
    const stale = await verifyWebhookSignature({ secret: SECRET, rawBody: body, signatureHeader: sig, timestampHeader: String(old), nowSeconds: now });
    expect(stale.valid).toBe(false);
    expect(stale.reason).toMatch(/tolerance/);
    const ok = await verifyWebhookSignature({ secret: SECRET, rawBody: body, signatureHeader: sig, timestampHeader: String(old), nowSeconds: now, toleranceSeconds: 0 });
    expect(ok.valid).toBe(true);
  });

  it('rejects missing headers', async () => {
    expect((await verifyWebhookSignature({ secret: SECRET, rawBody: body, signatureHeader: undefined, timestampHeader: String(now) })).valid).toBe(false);
    expect((await verifyWebhookSignature({ secret: SECRET, rawBody: body, signatureHeader: sign(SECRET, now, body), timestampHeader: null })).valid).toBe(false);
  });

  it('accepts a bare hex signature (no sha256= prefix)', async () => {
    const bare = createHmac('sha256', SECRET).update(`${now}.${body}`).digest('hex');
    const r = await verifyWebhookSignature({ secret: SECRET, rawBody: body, signatureHeader: bare, timestampHeader: String(now), nowSeconds: now });
    expect(r.valid).toBe(true);
  });
});

describe('constructWebhookEvent', () => {
  it('returns the typed event on success', async () => {
    const e = await constructWebhookEvent({ secret: SECRET, rawBody: body, signatureHeader: sign(SECRET, now, body), timestampHeader: String(now), nowSeconds: now });
    expect(e.type).toBe('score.band_changed');
    expect(e.id).toBe('evt_1');
  });

  it('throws on a bad signature', async () => {
    await expect(constructWebhookEvent({ secret: 'nope', rawBody: body, signatureHeader: sign(SECRET, now, body), timestampHeader: String(now), nowSeconds: now })).rejects.toThrow(/verification failed/);
  });

  it('narrows a dispute.resolved event to its typed payload', async () => {
    const d = { id: 'evt_2', type: 'dispute.resolved', createdAt: '2026-07-18T00:00:00.000Z', data: { disputeId: 'dsp_1', user: { externalId: 'u1' }, outcome: 'FOR_USER', status: 'RESOLVED_FOR_USER', lapsed: false, resolvedAt: '2026-07-18T00:00:00.000Z' } };
    const raw = JSON.stringify(d);
    const e = await constructWebhookEvent({ secret: SECRET, rawBody: raw, signatureHeader: sign(SECRET, now, raw), timestampHeader: String(now), nowSeconds: now });
    expect(e.type).toBe('dispute.resolved');
    if (e.type === 'dispute.resolved') {
      expect(e.data.disputeId).toBe('dsp_1'); // typed via the discriminated union
      expect(e.data.outcome).toBe('FOR_USER');
    }
  });

  it('throws on a malformed body (missing fields)', async () => {
    const bad = JSON.stringify({ hello: 'world' });
    await expect(constructWebhookEvent({ secret: SECRET, rawBody: bad, signatureHeader: sign(SECRET, now, bad), timestampHeader: String(now), nowSeconds: now })).rejects.toThrow(/missing required fields/);
  });
});
