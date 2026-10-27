import { Webhook, WebhookVerificationError } from 'standardwebhooks';
import { env } from './env.js';

export { WebhookVerificationError };

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

// Standard Webhooks scheme (https://www.standardwebhooks.com — Yoco's webhooks follow it
// exactly), verified via Yoco's own recommended `standardwebhooks` library rather than a
// hand-rolled HMAC check — also gives replay protection for free (rejects a
// webhook-timestamp more than 5 minutes stale or from the future, the library's own fixed
// WEBHOOK_TOLERANCE_IN_SECONDS). §4.4/§5.2 — this is the fail-closed gate: env.js already
// refuses to boot without YOCO_WEBHOOK_SECRET, and any verification failure (missing
// headers, bad signature, stale timestamp) throws WebhookVerificationError rather than
// ever treating a problem as "skip verification". Returns the already-JSON-parsed event
// payload on success — the raw body only needs to be read once, by this.
export function verifyAndParseWebhook({ headers, rawBody }) {
  const wh = new Webhook(env.YOCO_WEBHOOK_SECRET);
  return wh.verify(rawBody, headers);
}
