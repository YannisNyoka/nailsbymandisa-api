import { Router } from 'express';
import { z } from 'zod';
import * as authService from '../services/authService.js';
import { validate } from '../middleware/validate.js';
import { authenticate } from '../middleware/auth.js';
import { authLimiter, passwordResetLimiter } from '../middleware/rateLimit.js';
import { isProd, env } from '../config/env.js';
import { parseDurationMs } from '../utils/duration.js';

export const router = Router();

const REFRESH_COOKIE = 'refreshToken';
const REFRESH_COOKIE_PATH = '/api/auth';
const REFRESH_TTL_MS = parseDurationMs(env.JWT_REFRESH_TTL);

function setRefreshCookie(res, token) {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    path: REFRESH_COOKIE_PATH,
    maxAge: REFRESH_TTL_MS,
  });
}

function clearRefreshCookie(res) {
  res.clearCookie(REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH });
}

const passwordSchema = z.string().min(10, 'Password must be at least 10 characters.');

const registerSchema = z.object({
  email: z.string().email(),
  password: passwordSchema,
  firstName: z.string().min(1).max(80),
  lastName: z.string().min(1).max(80),
  phone: z.string().min(7).max(20).optional(),
  referralCode: z.string().min(1).max(20).optional(),
});

router.post('/register', authLimiter, validate(registerSchema), async (req, res, next) => {
  try {
    const { user, accessToken, refreshToken, welcomeDiscountCode } = await authService.register(req.body);
    setRefreshCookie(res, refreshToken);
    res.status(201).json({ user, accessToken, welcomeDiscountCode });
  } catch (err) {
    next(err);
  }
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

router.post('/login', authLimiter, validate(loginSchema), async (req, res, next) => {
  try {
    const { user, accessToken, refreshToken } = await authService.login(req.body);
    setRefreshCookie(res, refreshToken);
    res.json({ user, accessToken });
  } catch (err) {
    next(err);
  }
});

router.post('/refresh', authLimiter, async (req, res, next) => {
  try {
    const rawRefreshToken = req.cookies?.[REFRESH_COOKIE];
    const { user, accessToken, refreshToken } = await authService.refresh({ rawRefreshToken });
    setRefreshCookie(res, refreshToken);
    res.json({ user, accessToken });
  } catch (err) {
    clearRefreshCookie(res);
    next(err);
  }
});

router.post('/logout', async (req, res, next) => {
  try {
    const rawRefreshToken = req.cookies?.[REFRESH_COOKIE];
    await authService.logout({ rawRefreshToken });
    clearRefreshCookie(res);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.get('/me', authenticate, (req, res) => {
  res.json({ user: req.user });
});

const updateProfileSchema = z
  .object({
    firstName: z.string().min(1).max(80),
    lastName: z.string().min(1).max(80),
    phone: z.string().min(7).max(20).nullable(),
  })
  .partial();

router.patch('/me', authenticate, validate(updateProfileSchema), async (req, res, next) => {
  try {
    const user = await authService.updateProfile({ userId: req.user._id, ...req.body });
    res.json({ user });
  } catch (err) {
    next(err);
  }
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: passwordSchema,
});

// §5.5 — touches auth (verifies the current password), so it's rate-limited like every
// other credential-verification endpoint: an attacker with a hijacked session shouldn't
// get unlimited guesses at the current password.
router.post('/change-password', authenticate, authLimiter, validate(changePasswordSchema), async (req, res, next) => {
  try {
    await authService.changePassword({
      userId: req.user._id,
      currentPassword: req.body.currentPassword,
      newPassword: req.body.newPassword,
    });
    clearRefreshCookie(res);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

const requestResetSchema = z.object({ email: z.string().email() });

router.post(
  '/password-reset/request',
  passwordResetLimiter,
  validate(requestResetSchema),
  async (req, res, next) => {
    try {
      await authService.requestPasswordReset(req.body);
      // Same response whether or not the account exists — see authService comment.
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  }
);

const confirmResetSchema = z.object({
  token: z.string().min(1),
  newPassword: passwordSchema,
});

router.post(
  '/password-reset/confirm',
  passwordResetLimiter,
  validate(confirmResetSchema),
  async (req, res, next) => {
    try {
      await authService.resetPassword({ rawToken: req.body.token, newPassword: req.body.newPassword });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  }
);
