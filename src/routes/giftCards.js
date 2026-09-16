import { Router } from 'express';
import { z } from 'zod';
import { ObjectId } from 'mongodb';
import * as paymentsService from '../services/paymentsService.js';
import * as giftCardsService from '../services/giftCardsService.js';
import { giftCardsCollection } from '../models/giftCards.js';
import { validate } from '../middleware/validate.js';
import { authenticate, optionalAuthenticate, requirePermission } from '../middleware/auth.js';
import { checkoutLimiter } from '../middleware/rateLimit.js';
import { PERMISSIONS, PAGINATION } from '../config/constants.js';
import { notFound } from '../utils/AppError.js';

export const router = Router();

const purchaseSchema = z.object({
  amountCents: z.number().int().positive(),
  recipientEmail: z.string().email().nullable().optional(),
  purchaserEmail: z.string().email().optional(), // required for guests only, checked below
});

router.post('/purchase', optionalAuthenticate, checkoutLimiter, validate(purchaseSchema), async (req, res, next) => {
  try {
    const purchaserEmail = req.user?.email ?? req.body.purchaserEmail;
    const payment = await paymentsService.initiateGiftCardPurchase({
      amountCents: req.body.amountCents,
      purchaserUserId: req.user?._id ?? null,
      purchaserEmail,
      recipientEmail: req.body.recipientEmail ?? null,
    });
    res.status(201).json({ payment });
  } catch (err) {
    next(err);
  }
});

router.get('/me', authenticate, async (req, res, next) => {
  try {
    res.json({ giftCards: await giftCardsService.listGiftCardsForUser(req.user._id) });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const card = await giftCardsCollection().findOne({ _id: new ObjectId(req.params.id) });
    if (!card) throw notFound('Gift card');
    giftCardsService.assertGiftCardAccess(card, req.user);
    res.json({ giftCard: card });
  } catch (err) {
    next(err);
  }
});

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(PAGINATION.MAX_LIMIT).default(PAGINATION.DEFAULT_LIMIT),
});

router.get('/', authenticate, requirePermission(PERMISSIONS.MANAGE_GIFT_CARDS), validate(listQuerySchema, 'query'), async (req, res, next) => {
  try {
    res.json(await giftCardsService.listAllGiftCards(req.query));
  } catch (err) {
    next(err);
  }
});
