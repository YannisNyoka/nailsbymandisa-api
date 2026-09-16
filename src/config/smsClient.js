import { env } from './env.js';
import { logger } from './logger.js';

// Optional secondary channel (§4.11) — Twilio's SMS API. TWILIO_* are optional env vars
// (see .env.example); when unset, sendSms() is a documented no-op rather than throwing,
// so the app runs fine without SMS configured, exactly like it does without VAPID keys
// for push. Never silently pretend to send — log clearly that it was skipped.
const isConfigured = Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM_NUMBER);

export async function sendSms({ to, body }) {
  if (!isConfigured) {
    logger.debug({ to }, 'SMS skipped — Twilio is not configured');
    return { sent: false, reason: 'not_configured' };
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`;
  const auth = Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString('base64');
  const params = new URLSearchParams({ To: to, From: env.TWILIO_FROM_NUMBER, Body: body });

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
    });
    if (!res.ok) {
      const payload = await res.json().catch(() => null);
      logger.error({ to, status: res.status, payload }, 'Failed to send SMS via Twilio');
      return { sent: false, reason: 'provider_error' };
    }
    return { sent: true };
  } catch (err) {
    // An SMS failure must never take down the request that triggered it (mirrors
    // config/mailer.js's sendMail — log loudly, don't throw).
    logger.error({ err, to }, 'Failed to send SMS');
    return { sent: false, reason: 'network_error' };
  }
}
