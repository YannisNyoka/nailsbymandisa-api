import { Router } from 'express';
import { z } from 'zod';
import * as clientGalleryService from '../services/clientGalleryService.js';
import { clientGalleryCollection } from '../models/clientGallery.js';
import { validate } from '../middleware/validate.js';
import { authenticate, requirePermission } from '../middleware/auth.js';
import { PERMISSIONS, PAGINATION } from '../config/constants.js';

export const router = Router();

router.get('/', async (req, res, next) => {
  try {
    res.json({ submissions: await clientGalleryService.listApproved() });
  } catch (err) {
    next(err);
  }
});

router.get('/mine', authenticate, async (req, res, next) => {
  try {
    const submissions = await (await clientGalleryCollection().find({ submittedByUserId: req.user._id })).toArray();
    res.json({ submissions: submissions.sort((a, b) => b.createdAt - a.createdAt) });
  } catch (err) {
    next(err);
  }
});

// Admin moderation queue — separate from the public list above, which only ever shows
// approved submissions (§5.3: a customer's pending/rejected photo isn't for other
// customers to see, so this is gated rather than exposed via a query param on the
// public route).
const queueQuerySchema = z.object({
  status: z.enum(['pending', 'approved', 'rejected']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(PAGINATION.MAX_LIMIT).default(PAGINATION.DEFAULT_LIMIT),
});

router.get('/queue', authenticate, requirePermission(PERMISSIONS.MANAGE_GALLERY), validate(queueQuerySchema, 'query'), async (req, res, next) => {
  try {
    const { status, ...pageParams } = req.query;
    res.json(await clientGalleryService.listByStatus(status, pageParams));
  } catch (err) {
    next(err);
  }
});

const submitSchema = z.object({
  imageUrl: z.string().url(),
  caption: z.string().max(500).nullable().optional(),
});

router.post('/', authenticate, validate(submitSchema), async (req, res, next) => {
  try {
    const submission = await clientGalleryService.submit({ userId: req.user._id, ...req.body });
    res.status(201).json({ submission });
  } catch (err) {
    next(err);
  }
});

const moderateSchema = z.object({ status: z.enum(['approved', 'rejected']) });

router.patch(
  '/:id/moderate',
  authenticate,
  requirePermission(PERMISSIONS.MANAGE_GALLERY),
  validate(moderateSchema),
  async (req, res, next) => {
    try {
      const submission = await clientGalleryService.moderate({
        id: req.params.id,
        status: req.body.status,
        moderatorId: req.user._id,
      });
      res.json({ submission });
    } catch (err) {
      next(err);
    }
  }
);

router.delete('/:id', authenticate, async (req, res, next) => {
  try {
    await clientGalleryService.deleteSubmission(req.params.id, req.user);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.post('/:id/like', authenticate, async (req, res, next) => {
  try {
    res.json(await clientGalleryService.toggleLike(req.params.id, req.user._id));
  } catch (err) {
    next(err);
  }
});
