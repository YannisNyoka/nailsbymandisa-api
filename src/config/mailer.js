import nodemailer from 'nodemailer';
import { env, isTest } from './env.js';
import { logger } from './logger.js';

const transporter = isTest
  ? null
  : nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_PORT === 465,
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    });

// §4.11 — transactional email is sent server-side, never client-side-only, so the
// content is authoritative and delivery doesn't depend on the customer's browser staying open.
export async function sendMail({ to, subject, html, text }) {
  if (isTest) {
    logger.debug({ to, subject }, 'sendMail skipped in test env');
    return;
  }
  try {
    await transporter.sendMail({ from: env.EMAIL_FROM, to, subject, html, text });
  } catch (err) {
    // A failed transactional email must never take down the request that triggered it
    // (e.g. a paid booking) — log it loudly so it's visible to error tracking, but don't throw.
    logger.error({ err, to, subject }, 'Failed to send email');
  }
}
