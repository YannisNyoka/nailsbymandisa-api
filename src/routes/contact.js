import { Router } from 'express';
import { z } from 'zod';
import * as enquiriesService from '../services/enquiriesService.js';
import { validate } from '../middleware/validate.js';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { contactLimiter } from '../middleware/rateLimit.js';
import { PERMISSIONS } from '../config/constants.js';

export const router = Router();

const submitSchema = z.object({
  name: z.string().trim().max(200).optional(),
  email: z.string().trim().email().max(320),
  message: z.string().trim().min(1).max(5000),
});

// Public — no auth, so the site's own "Contact us" form works for a visitor who isn't
// signed in (the common case). contactLimiter is the abuse guard in place of auth.
router.post('/', contactLimiter, validate(submitSchema), async (req, res, next) => {
  try {
    await enquiriesService.submitEnquiry(req.body);
    res.status(201).json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.get('/', authenticate, requirePermission(PERMISSIONS.MANAGE_ENQUIRIES), async (req, res, next) => {
  try {
    res.json(await enquiriesService.listEnquiries());
  } catch (err) {
    next(err);
  }
});

router.patch('/:id/read', authenticate, requirePermission(PERMISSIONS.MANAGE_ENQUIRIES), async (req, res, next) => {
  try {
    res.json({ enquiry: await enquiriesService.markEnquiryRead(req.params.id) });
  } catch (err) {
    next(err);
  }
});
