import { Router } from 'express';
import { z } from 'zod';
import * as clientNotificationsService from '../services/clientNotificationsService.js';
import { validate } from '../middleware/validate.js';
import { authenticate } from '../middleware/auth.js';
import { PAGINATION } from '../config/constants.js';

export const router = Router();

router.use(authenticate);

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(PAGINATION.MAX_LIMIT).default(PAGINATION.DEFAULT_LIMIT),
});

router.get('/', validate(listQuerySchema, 'query'), async (req, res, next) => {
  try {
    const result = await clientNotificationsService.listForUser(req.user._id, req.query);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post('/read-all', async (req, res, next) => {
  try {
    await clientNotificationsService.markAllRead(req.user._id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.patch('/:id/read', async (req, res, next) => {
  try {
    await clientNotificationsService.markRead(req.params.id, req.user._id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    await clientNotificationsService.deleteNotification(req.params.id, req.user._id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
