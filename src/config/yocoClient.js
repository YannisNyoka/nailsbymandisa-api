import crypto from 'node:crypto';
import { env } from './env.js';

// Thin wrapper around Yoco's Checkout API (https://developer.yoco.com/online). Kept as
// the ONLY module that knows Yoco's URLs/payload shapes, so paymentsService stays
// testable via dependency injection (pass a fake `yoco` client in tests) instead of
// mocking HTTP. Verified against Yoco's current docs 2026-09 — re-check before
// production if this integration has sat untouched for a long time.

const API_BASE = 'https://payments.yoco.com/api';

async function yocoFetch(path, { method = 'POST', body, idempotencyKey } = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.YOCO_SECRET_KEY}`,
      'Content-Type': 'application/json',
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    const message = payload?.message || `Yoco API error (${res.status})`;
    const error = new Error(message);
    error.status = res.status;
    error.yocoResponse = payload;
    throw error;
  }
  return payload;
}

export async function createCheckout({ amountCents, currency = 'ZAR', successUrl, cancelUrl, failureUrl, metadata, idempotencyKey }) {
  return yocoFetch('/checkouts', {
    body: { amount: amountCents, currency, successUrl, cancelUrl, failureUrl, metadata },
    idempotencyKey,
  });
}

export async function createRefund({ checkoutId, amountCents, metadata, idempotencyKey }) {
  return yocoFetch(`/checkouts/${checkoutId}/refund`, {
    body: { ...(amountCents != null ? { amount: amountCents } : {}), metadata },
    idempotencyKey,
  });
}

// Standard Webhooks scheme (https://www.standardwebhooks.com — Yoco's webhooks follow
// it exactly): sign "{id}.{timestamp}.{raw body}" with HMAC-SHA256 using the base64
// portion of the whsec_-prefixed secret, compare against the "v1,<sig>" value(s) in the
// webhook-signature header. §4.4/§5.2 — this is the fail-closed gate: env.js already
// refuses to boot without YOCO_WEBHOOK_SECRET, and a missing/malformed signature header
// here is treated as invalid, never as "skip verification".
export function verifyWebhookSignature({ webhookId, webhookTimestamp, webhookSignature, rawBody }) {
  if (!webhookId || !webhookTimestamp || !webhookSignature) return false;

  const secretBytes = Buffer.from(env.YOCO_WEBHOOK_SECRET.split('_').pop(), 'base64');
  const signedContent = `${webhookId}.${webhookTimestamp}.${rawBody}`;
  const expected = crypto.createHmac('sha256', secretBytes).update(signedContent).digest('base64');
  const expectedBuf = Buffer.from(expected);

  return webhookSignature
    .split(' ')
    .map((part) => part.split(',')[1])
    .filter(Boolean)
    .some((sig) => {
      const sigBuf = Buffer.from(sig);
      return sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf);
    });
}
