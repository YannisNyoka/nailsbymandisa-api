import { Router } from 'express';
import { z } from 'zod';
import * as galleryService from '../services/galleryService.js';
import { validate } from '../middleware/validate.js';
import { authenticate, optionalAuthenticate, requirePermission } from '../middleware/auth.js';
import { PERMISSIONS, ROLES, PAGINATION } from '../config/constants.js';

export const router = Router();

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(PAGINATION.MAX_LIMIT).default(PAGINATION.DEFAULT_LIMIT),
});

router.get('/', optionalAuthenticate, validate(listQuerySchema, 'query'), async (req, res, next) => {
  try {
    const isAdmin = req.user?.role === ROLES.ADMIN;
    if (isAdmin) return res.json(await galleryService.listAll(req.query));
    res.json({ gallery: await galleryService.listPublished() });
  } catch (err) {
    next(err);
  }
});

const createSchema = z.object({
  mediaUrl: z.string().url(),
  mediaType: z.enum(['image', 'video']),
  caption: z.string().max(500).nullable().optional(),
});

router.post('/', authenticate, requirePermission(PERMISSIONS.MANAGE_GALLERY), validate(createSchema), async (req, res, next) => {
  try {
    const item = await galleryService.createItem({ ...req.body, createdBy: req.user._id });
    res.status(201).json({ item });
  } catch (err) {
    next(err);
  }
});

router.patch(
  '/:id',
  authenticate,
  requirePermission(PERMISSIONS.MANAGE_GALLERY),
  validate(createSchema.partial().extend({ isPublished: z.boolean().optional() })),
  async (req, res, next) => {
    try {
      res.json({ item: await galleryService.updateItem(req.params.id, req.body) });
    } catch (err) {
      next(err);
    }
  }
);

router.delete('/:id', authenticate, requirePermission(PERMISSIONS.MANAGE_GALLERY), async (req, res, next) => {
  try {
    await galleryService.deleteItem(req.params.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.post('/:id/like', authenticate, async (req, res, next) => {
  try {
    res.json(await galleryService.toggleLike(req.params.id, req.user._id));
  } catch (err) {
    next(err);
  }
});
