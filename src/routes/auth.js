import { Router } from 'express';
import { z } from 'zod';
import * as authService from '../services/authService.js';
import { validate } from '../middleware/validate.js';
import { authenticate } from '../middleware/auth.js';
import { authLimiter, refreshLimiter, passwordResetLimiter } from '../middleware/rateLimit.js';

export const router = Router();

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
    res.status(201).json({ user, accessToken, refreshToken, welcomeDiscountCode });
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
    res.json({ user, accessToken, refreshToken });
  } catch (err) {
    next(err);
  }
});

// Took the refresh token itself in an httpOnly cookie rather than here, until a real
// repro showed mobile browsers (Samsung Internet's default cross-site-cookie block among
// them) silently refusing to store or send a cookie set by a different domain than the
// one the user is browsing (Vercel frontend, Render API) — every page reload looked like
// a logout, with no way to detect or recover from it client-side. The frontend now holds
// this token itself (its own origin's storage, not a cookie) and presents it explicitly,
// which no cross-site cookie policy has any say over. Trades away httpOnly's
// JS-can-never-read-it protection for that reliability.
const refreshSchema = z.object({ refreshToken: z.string().min(1) });

router.post('/refresh', refreshLimiter, validate(refreshSchema), async (req, res, next) => {
  try {
    const { user, accessToken, refreshToken } = await authService.refresh({ rawRefreshToken: req.body.refreshToken });
    res.json({ user, accessToken, refreshToken });
  } catch (err) {
    next(err);
  }
});

const logoutSchema = z.object({ refreshToken: z.string().min(1).optional() });

router.post('/logout', validate(logoutSchema), async (req, res, next) => {
  try {
    if (req.body.refreshToken) await authService.logout({ rawRefreshToken: req.body.refreshToken });
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
