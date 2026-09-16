import { Router } from 'express';
import { z } from 'zod';
import * as discountsService from '../services/discountsService.js';
import { validate } from '../middleware/validate.js';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { codeValidationLimiter } from '../middleware/rateLimit.js';
import { PERMISSIONS, PAGINATION } from '../config/constants.js';
import { DISCOUNT_TYPES } from '../models/discountCodes.js';

export const router = Router();

// Public (guests can apply a code too) — §5.5 rate-limits discount validation since it's
// a low-cost way to probe for valid codes otherwise.
const validateSchema = z.object({ code: z.string().min(1).max(20), amountCents: z.number().int().min(0) });
router.post('/validate', codeValidationLimiter, validate(validateSchema), async (req, res, next) => {
  try {
    const { discount, discountValueCents } = await discountsService.validateDiscountCode(req.body);
    res.json({ valid: true, type: discount.type, value: discount.value, discountValueCents });
  } catch (err) {
    next(err);
  }
});

router.use(authenticate, requirePermission(PERMISSIONS.MANAGE_DISCOUNTS));

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(PAGINATION.MAX_LIMIT).default(PAGINATION.DEFAULT_LIMIT),
});

router.get('/', validate(listQuerySchema, 'query'), async (req, res, next) => {
  try {
    res.json(await discountsService.listDiscountCodes(req.query));
  } catch (err) {
    next(err);
  }
});

const createSchema = z.object({
  code: z.string().min(3).max(20).optional(),
  type: z.enum(Object.values(DISCOUNT_TYPES)),
  value: z.number().int().min(1),
  minBookingAmountCents: z.number().int().min(0).nullable().optional(),
  usageLimit: z.number().int().min(1).nullable().optional(),
  expiresAt: z.coerce.date().nullable().optional(),
});

router.post('/', validate(createSchema), async (req, res, next) => {
  try {
    const discountCode = await discountsService.createDiscountCode({ ...req.body, source: 'admin' });
    res.status(201).json({ discountCode });
  } catch (err) {
    next(err);
  }
});

const setActiveSchema = z.object({ isActive: z.boolean() });

router.patch('/:id', validate(setActiveSchema), async (req, res, next) => {
  try {
    await discountsService.setDiscountCodeActive(req.params.id, req.body.isActive);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
