import { Router } from 'express';
import { z } from 'zod';
import * as loyaltyService from '../services/loyaltyService.js';
import { validate } from '../middleware/validate.js';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { PERMISSIONS, PAGINATION } from '../config/constants.js';

export const router = Router();

router.use(authenticate);

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(PAGINATION.MAX_LIMIT).default(PAGINATION.DEFAULT_LIMIT),
});

// §4.5 — the customer's own ledger: balance, tier, and every transaction.
router.get('/me', validate(listQuerySchema, 'query'), async (req, res, next) => {
  try {
    res.json(await loyaltyService.getLedger(req.user._id, req.query));
  } catch (err) {
    next(err);
  }
});

// Admin per-client view (§4.5/§4.12 — "loyalty ledger" in the client detail screen).
router.get(
  '/clients/:userId',
  requirePermission(PERMISSIONS.MANAGE_LOYALTY),
  validate(listQuerySchema, 'query'),
  async (req, res, next) => {
    try {
      res.json(await loyaltyService.getLedger(req.params.userId, req.query));
    } catch (err) {
      next(err);
    }
  }
);

const adjustSchema = z.object({
  points: z.number().int().refine((v) => v !== 0, 'points must not be zero'),
  note: z.string().max(500).nullable().optional(),
});

// Admin manual adjustment (e.g. goodwill points, correcting an error) — goes through
// the same awardPoints()/atomic-ledger machinery as every other point movement, just
// with a negative delta allowed and its own source tag for the audit trail.
router.post(
  '/clients/:userId/adjust',
  requirePermission(PERMISSIONS.MANAGE_LOYALTY),
  validate(adjustSchema),
  async (req, res, next) => {
    try {
      if (req.body.points > 0) {
        await loyaltyService.awardPoints({
          userId: req.params.userId,
          points: req.body.points,
          source: 'admin_adjustment',
          note: req.body.note,
        });
      } else {
        await loyaltyService.adjustPointsDown({
          userId: req.params.userId,
          points: -req.body.points,
          note: req.body.note,
        });
      }
      res.json(await loyaltyService.getLedger(req.params.userId));
    } catch (err) {
      next(err);
    }
  }
);
