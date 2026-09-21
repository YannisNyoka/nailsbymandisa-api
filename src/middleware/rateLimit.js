import rateLimit from 'express-rate-limit';
import { isTest } from '../config/env.js';

// §5.5 — every endpoint that costs money, sends a message, or touches auth must be
// rate-limited. Build one of these per route group with limits sized to that route,
// rather than one blanket limiter for the whole app.
export function makeLimiter({ windowMs, max, message = 'Too many requests, please try again later.' }) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => isTest,
    message: { error: { message, code: 'RATE_LIMITED' } },
  });
}

export const authLimiter = makeLimiter({ windowMs: 15 * 60 * 1000, max: 10 });
// §gap-fix — /auth/refresh used to share authLimiter with login/register/change-password.
// Those are deliberate, infrequent, user-initiated actions where a tight cap makes sense
// as brute-force protection. Refresh is neither: the frontend calls it silently on every
// app load and whenever the short-lived access token expires (§ apiClient.js, AuthContext),
// so a real user just browsing several pages — or with a couple of tabs open — could
// exhaust a 10-per-15-minutes cap through completely normal use and get silently logged
// out. Found by a full-app route sweep exhausting the shared limiter in under 30 page
// loads. Kept bounded (not unlimited) so it's still a real brute-force backstop for
// refresh-token guessing, just sized for legitimate SPA usage instead of for login.
export const refreshLimiter = makeLimiter({ windowMs: 15 * 60 * 1000, max: 120 });
export const passwordResetLimiter = makeLimiter({ windowMs: 60 * 60 * 1000, max: 5 });
export const checkoutLimiter = makeLimiter({ windowMs: 15 * 60 * 1000, max: 20 });
export const codeValidationLimiter = makeLimiter({ windowMs: 15 * 60 * 1000, max: 30 });
export const messagingLimiter = makeLimiter({ windowMs: 60 * 60 * 1000, max: 20 });
export const uploadLimiter = makeLimiter({ windowMs: 15 * 60 * 1000, max: 30 });
// Public, unauthenticated, and triggers a real outbound email — sized to block a spam
// bot hammering the form, not to accommodate a legitimate high-frequency use case (a real
// visitor submits this once, maybe twice).
export const contactLimiter = makeLimiter({ windowMs: 60 * 60 * 1000, max: 5 });
// The reminders workflow calls this at most hourly — a generous ceiling, just to blunt
// brute-forcing CRON_SECRET rather than to accommodate legitimate retries.
export const cronLimiter = makeLimiter({ windowMs: 15 * 60 * 1000, max: 20 });
