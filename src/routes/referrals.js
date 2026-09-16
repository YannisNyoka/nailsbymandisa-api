import { Router } from 'express';
import { referralsCollection } from '../models/referrals.js';
import { authenticate } from '../middleware/auth.js';

export const router = Router();

// §4.6 — the customer's own referral code (to share) and the status of everyone they've
// referred. IDOR-safe by construction: only ever queries by the caller's own id.
router.get('/me', authenticate, async (req, res, next) => {
  try {
    const referrals = await (await referralsCollection().find({ referrerUserId: req.user._id })).toArray();
    res.json({
      referralCode: req.user.referralCode,
      referrals: referrals.map((r) => ({ status: r.status, createdAt: r.createdAt, completedAt: r.completedAt })),
    });
  } catch (err) {
    next(err);
  }
});
