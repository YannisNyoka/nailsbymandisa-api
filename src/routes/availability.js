import { Router } from 'express';
import { z } from 'zod';
import * as availabilityService from '../services/availabilityService.js';
import { validate } from '../middleware/validate.js';
import { authenticate, requirePermission, requirePermissionOrStaffSelf } from '../middleware/auth.js';
import { PERMISSIONS, ROLES } from '../config/constants.js';

export const router = Router();

// Admin-only: blocked-slot reasons are internal notes, and this is a different surface
// from the customer-facing "what times can I book" endpoint (built with the booking
// engine in step 4), which derives availability from this data without exposing it raw.
// GET is also reachable by a linked staff account (for their own schedule view), scoped
// to their own employeeId below; every write stays admin-permission-only.
router.use(authenticate);

const listQuerySchema = z.object({
  employeeId: z.string().optional(),
  dateFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  dateTo: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

router.get('/', requirePermissionOrStaffSelf(PERMISSIONS.MANAGE_AVAILABILITY), validate(listQuerySchema, 'query'), async (req, res, next) => {
  try {
    const isStaff = req.user.role === ROLES.STAFF;
    const employeeId = isStaff ? req.user.employeeId : req.query.employeeId;
    res.json({ blocks: await availabilityService.listAvailability({ ...req.query, employeeId }) });
  } catch (err) {
    next(err);
  }
});

router.use(requirePermission(PERMISSIONS.MANAGE_AVAILABILITY));

const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const blockSchema = z.object({
  employeeId: z.string().nullable().optional(),
  date: dateSchema,
  startTime: timeSchema,
  endTime: timeSchema,
  reason: z.string().max(500).nullable().optional(),
});

router.post('/', validate(blockSchema), async (req, res, next) => {
  try {
    const block = await availabilityService.createBlock({ ...req.body, createdBy: req.user._id });
    res.status(201).json({ block });
  } catch (err) {
    next(err);
  }
});

const bulkBlockSchema = z.object({
  employeeId: z.string().nullable().optional(),
  dateFrom: dateSchema,
  dateTo: dateSchema,
  startTime: timeSchema,
  endTime: timeSchema,
  reason: z.string().max(500).nullable().optional(),
});

router.post('/bulk', validate(bulkBlockSchema), async (req, res, next) => {
  try {
    const blocks = await availabilityService.createBulkBlock({ ...req.body, createdBy: req.user._id });
    res.status(201).json({ blocks });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    await availabilityService.deleteBlock(req.params.id);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});
