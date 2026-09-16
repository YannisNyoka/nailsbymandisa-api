import crypto from 'node:crypto';
import { env } from '../../src/config/env.js';

// Mirrors config/yocoClient.js's verifyWebhookSignature() so tests can construct a
// validly-signed webhook request without hitting the network — this is the same
// Standard Webhooks HMAC scheme Yoco uses in production.
//
// Defaults to env.YOCO_WEBHOOK_SECRET (the cached, parsed value verifyWebhookSignature()
// actually checks against) rather than process.env directly — setup.env.js regenerates a
// fresh random secret per test FILE, but env.js only reads process.env once, on its first
// import across the whole Jest run, so a later file's process.env has already diverged.
export function signWebhookBody(bodyObject, secret = env.YOCO_WEBHOOK_SECRET) {
  const rawBody = JSON.stringify(bodyObject);
  const webhookId = `msg_${crypto.randomUUID()}`;
  const webhookTimestamp = String(Math.floor(Date.now() / 1000));
  const secretBytes = Buffer.from(secret.split('_').pop(), 'base64');
  const signedContent = `${webhookId}.${webhookTimestamp}.${rawBody}`;
  const signature = crypto.createHmac('sha256', secretBytes).update(signedContent).digest('base64');

  return {
    rawBody,
    headers: {
      'webhook-id': webhookId,
      'webhook-timestamp': webhookTimestamp,
      'webhook-signature': `v1,${signature}`,
    },
  };
}
