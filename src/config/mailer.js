import { Resend } from 'resend';
import { env, isTest } from './env.js';
import { logger } from './logger.js';

const resend = isTest ? null : new Resend(env.RESEND_API_KEY);

// §4.11 — transactional email is sent server-side, never client-side-only, so the
// content is authoritative and delivery doesn't depend on the customer's browser staying
// open. Sent via Resend (resend.com) rather than raw SMTP — see README "Email (Resend)"
// for the account/domain-verification setup this depends on.
export async function sendMail({ to, subject, html, text }) {
  if (isTest) {
    logger.debug({ to, subject }, 'sendMail skipped in test env');
    return;
  }
  try {
    const { error } = await resend.emails.send({ from: env.EMAIL_FROM, to, subject, html, text });
    // The Resend SDK resolves (doesn't throw) on a provider-level failure — the error
    // comes back in the response body instead, so it has to be checked explicitly or a
    // failure would look identical to success here.
    if (error) throw error;
  } catch (err) {
    // A failed transactional email must never take down the request that triggered it
    // (e.g. a paid booking) — log it loudly so it's visible to error tracking, but don't throw.
    logger.error({ err, to, subject }, 'Failed to send email');
  }
}
