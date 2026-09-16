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
export const passwordResetLimiter = makeLimiter({ windowMs: 60 * 60 * 1000, max: 5 });
export const checkoutLimiter = makeLimiter({ windowMs: 15 * 60 * 1000, max: 20 });
export const codeValidationLimiter = makeLimiter({ windowMs: 15 * 60 * 1000, max: 30 });
export const messagingLimiter = makeLimiter({ windowMs: 60 * 60 * 1000, max: 20 });
export const uploadLimiter = makeLimiter({ windowMs: 15 * 60 * 1000, max: 30 });
