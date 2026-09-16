import { Router } from 'express';
import { z } from 'zod';
import * as servicesService from '../services/servicesService.js';
import { validate } from '../middleware/validate.js';
import { authenticate, optionalAuthenticate, requirePermission } from '../middleware/auth.js';
import { PERMISSIONS, ROLES } from '../config/constants.js';
import { SERVICE_CATEGORIES } from '../models/services.js';

export const router = Router();

router.get('/', optionalAuthenticate, async (req, res, next) => {
  try {
    const isAdmin = req.user?.role === ROLES.ADMIN;
    const services = await servicesService.listServices({ includeInactive: isAdmin });
    res.json({ services });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    res.json({ service: await servicesService.getService(req.params.id) });
  } catch (err) {
    next(err);
  }
});

const serviceSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).nullable().optional(),
  category: z.enum(SERVICE_CATEGORIES),
  durationMinutes: z.number().int().min(5).max(480),
  priceCents: z.number().int().min(0),
  isActive: z.boolean().optional(),
});

router.post(
  '/',
  authenticate,
  requirePermission(PERMISSIONS.MANAGE_SERVICES),
  validate(serviceSchema),
  async (req, res, next) => {
    try {
      res.status(201).json({ service: await servicesService.createService(req.body) });
    } catch (err) {
      next(err);
    }
  }
);

router.patch(
  '/:id',
  authenticate,
  requirePermission(PERMISSIONS.MANAGE_SERVICES),
  validate(serviceSchema.partial()),
  async (req, res, next) => {
    try {
      res.json({ service: await servicesService.updateService(req.params.id, req.body) });
    } catch (err) {
      next(err);
    }
  }
);

router.delete('/:id', authenticate, requirePermission(PERMISSIONS.MANAGE_SERVICES), async (req, res, next) => {
  try {
    await servicesService.deleteService(req.params.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
