import { Router } from 'express';
import { z } from 'zod';
import * as employeesService from '../services/employeesService.js';
import { validate } from '../middleware/validate.js';
import { authenticate, optionalAuthenticate, requirePermission } from '../middleware/auth.js';
import { PERMISSIONS, ROLES } from '../config/constants.js';
import { WEEKDAYS } from '../models/employees.js';

export const router = Router();

// §4.1 — public staff schedule (working hours) is fine to expose; it carries no client
// PII. Nothing about a customer's own bookings is returned from this endpoint.
router.get('/', optionalAuthenticate, async (req, res, next) => {
  try {
    const isAdmin = req.user?.role === ROLES.ADMIN;
    const employees = await employeesService.listEmployees({ includeInactive: isAdmin });
    res.json({ employees });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    res.json({ employee: await employeesService.getEmployee(req.params.id) });
  } catch (err) {
    next(err);
  }
});

const shiftSchema = z.object({
  start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
});

const employeeSchema = z.object({
  name: z.string().min(1).max(120),
  bio: z.string().max(2000).nullable().optional(),
  photoUrl: z.string().url().nullable().optional(),
  workingHours: z.object(Object.fromEntries(WEEKDAYS.map((d) => [d, z.array(shiftSchema)]))).optional(),
  serviceIds: z.array(z.string()).nullable().optional(),
  isActive: z.boolean().optional(),
});

router.post(
  '/',
  authenticate,
  requirePermission(PERMISSIONS.MANAGE_STAFF),
  validate(employeeSchema),
  async (req, res, next) => {
    try {
      res.status(201).json({ employee: await employeesService.createEmployee(req.body) });
    } catch (err) {
      next(err);
    }
  }
);

router.patch(
  '/:id',
  authenticate,
  requirePermission(PERMISSIONS.MANAGE_STAFF),
  validate(employeeSchema.partial()),
  async (req, res, next) => {
    try {
      res.json({ employee: await employeesService.updateEmployee(req.params.id, req.body) });
    } catch (err) {
      next(err);
    }
  }
);

router.delete('/:id', authenticate, requirePermission(PERMISSIONS.MANAGE_STAFF), async (req, res, next) => {
  try {
    await employeesService.deleteEmployee(req.params.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
