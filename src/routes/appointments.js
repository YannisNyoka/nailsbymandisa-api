import { Router } from 'express';
import { z } from 'zod';
import * as bookingService from '../services/bookingService.js';
import { appointmentsCollection } from '../models/appointments.js';
import { usersCollection } from '../models/users.js';
import { validate } from '../middleware/validate.js';
import { authenticate, optionalAuthenticate, requirePermission } from '../middleware/auth.js';
import { checkoutLimiter } from '../middleware/rateLimit.js';
import { PERMISSIONS, ROLES, PAGINATION, ANY_AVAILABLE_EMPLOYEE } from '../config/constants.js';
import { forbidden } from '../utils/AppError.js';
import { ObjectId } from 'mongodb';

export const router = Router();

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const idListSchema = z
  .string()
  .min(1)
  .transform((s) => s.split(',').map((v) => v.trim()));

const slotsQuerySchema = z.object({
  serviceIds: idListSchema,
  date: dateSchema,
  employeeId: z.string().optional(),
});

router.get('/slots', validate(slotsQuerySchema, 'query'), async (req, res, next) => {
  try {
    const { serviceIds, date, employeeId } = req.query;
    const slots = await bookingService.listAvailableSlots({ serviceIds, date, employeeId });
    res.json({ slots });
  } catch (err) {
    next(err);
  }
});

const guestInfoSchema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email(),
  phone: z.string().min(7).max(20),
});

const createAppointmentSchema = z.object({
  serviceIds: z.array(z.string()).min(1),
  date: dateSchema,
  startTime: timeSchema,
  employeeId: z.string().default(ANY_AVAILABLE_EMPLOYEE),
  notes: z.string().max(1000).nullable().optional(),
  guestInfo: guestInfoSchema.optional(),
  onBehalfOfUserId: z.string().optional(),
});

// Single entry point for both the guest-friendly public wizard and the logged-in
// booking dashboard (§4.3) — identity branches here, in the thin route layer; the
// validation/pricing/creation logic in bookingService never forks by caller.
router.post('/', optionalAuthenticate, checkoutLimiter, validate(createAppointmentSchema), async (req, res, next) => {
  try {
    const isAdmin = req.user?.role === ROLES.ADMIN;
    let userId = null;
    let guestInfo = null;
    let createdByAdminId = null;

    if (isAdmin && req.body.onBehalfOfUserId) {
      userId = req.body.onBehalfOfUserId;
      createdByAdminId = req.user._id;
    } else if (isAdmin && req.body.guestInfo) {
      guestInfo = req.body.guestInfo;
      createdByAdminId = req.user._id;
    } else if (req.user) {
      userId = req.user._id;
    } else if (req.body.guestInfo) {
      guestInfo = req.body.guestInfo;
    } else {
      return next(forbidden('Log in or provide guest contact details to book.'));
    }

    const appointment = await bookingService.createAppointment({
      userId,
      guestInfo,
      employeeId: req.body.employeeId,
      serviceIds: req.body.serviceIds,
      date: req.body.date,
      startTime: req.body.startTime,
      notes: req.body.notes,
      createdByAdminId,
    });
    res.status(201).json({ appointment });
  } catch (err) {
    next(err);
  }
});

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(PAGINATION.MAX_LIMIT).default(PAGINATION.DEFAULT_LIMIT),
  date: dateSchema.optional(),
  status: z.string().optional(),
  employeeId: z.string().optional(),
  serviceId: z.string().optional(),
  clientSearch: z.string().max(200).optional(),
});

router.get('/me', authenticate, validate(listQuerySchema, 'query'), async (req, res, next) => {
  try {
    const { page, pageSize } = req.query;
    const all = await (await appointmentsCollection().find({ userId: req.user._id })).toArray();
    const start = (page - 1) * pageSize;
    res.json({ appointments: all.slice(start, start + pageSize), total: all.length, page, pageSize });
  } catch (err) {
    next(err);
  }
});

// Admin-only full list, filterable/paginated for the appointments table (§4.12).
router.get('/', authenticate, requirePermission(PERMISSIONS.MANAGE_APPOINTMENTS), validate(listQuerySchema, 'query'), async (req, res, next) => {
  try {
    const { page, pageSize, date, status, employeeId, serviceId, clientSearch } = req.query;
    const filter = {};
    if (date) filter.date = date;
    if (status) filter.status = status;
    if (employeeId) filter.employeeId = new ObjectId(employeeId);
    let all = await (await appointmentsCollection().find(filter)).toArray();

    if (serviceId) {
      all = all.filter((a) => a.serviceIds.some((id) => String(id) === serviceId));
    }

    // A logged-in booking has no name/email of its own (just a userId reference) — a
    // guest booking does (guestInfo). Join the small set of referenced users once rather
    // than a query per appointment; used both for the clientSearch filter below and to
    // attach a display name/email to every returned row (the admin table has no other
    // way to show who a booking is for).
    const userIds = [...new Set(all.filter((a) => a.userId).map((a) => String(a.userId)))];
    const users = userIds.length
      ? await (await usersCollection().find({ _id: { $in: userIds.map((id) => new ObjectId(id)) } })).toArray()
      : [];
    const usersById = new Map(users.map((u) => [String(u._id), u]));
    const identityFor = (a) =>
      a.userId
        ? usersById.get(String(a.userId))
        : { firstName: a.guestInfo?.name, lastName: '', email: a.guestInfo?.email };

    if (clientSearch) {
      const needle = clientSearch.trim().toLowerCase();
      all = all.filter((a) => {
        const identity = identityFor(a);
        if (!identity) return false;
        const haystack = `${identity.firstName || ''} ${identity.lastName || ''} ${identity.email || ''}`.toLowerCase();
        return haystack.includes(needle);
      });
    }

    const start = (page - 1) * pageSize;
    const pageOfAppointments = all.slice(start, start + pageSize).map((a) => {
      const identity = identityFor(a);
      const clientName = identity ? `${identity.firstName || ''} ${identity.lastName || ''}`.trim() : null;
      return { ...a, clientName: clientName || null, clientEmail: identity?.email || null };
    });
    res.json({ appointments: pageOfAppointments, total: all.length, page, pageSize });
  } catch (err) {
    next(err);
  }
});

// IDOR guard (§5.3): fetch first, then confirm the caller owns this appointment or is
// an admin, before returning anything — a customer must never see another customer's
// booking (name/phone/notes) by guessing an id.
router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const appointment = await bookingService.getAppointment(req.params.id);
    const isOwner = appointment.userId && String(appointment.userId) === String(req.user._id);
    if (!isOwner && req.user.role !== ROLES.ADMIN) return next(forbidden());
    res.json({ appointment });
  } catch (err) {
    next(err);
  }
});

const rescheduleSchema = z.object({ date: dateSchema, startTime: timeSchema });

router.post('/:id/reschedule', authenticate, validate(rescheduleSchema), async (req, res, next) => {
  try {
    const appointment = await bookingService.rescheduleAppointment({
      appointmentId: req.params.id,
      date: req.body.date,
      startTime: req.body.startTime,
      actor: req.user,
    });
    res.json({ appointment });
  } catch (err) {
    next(err);
  }
});

const cancelSchema = z.object({ reason: z.string().max(500).nullable().optional() });

router.post('/:id/cancel', authenticate, validate(cancelSchema), async (req, res, next) => {
  try {
    const appointment = await bookingService.cancelAppointment({
      appointmentId: req.params.id,
      actor: req.user,
      reason: req.body.reason,
    });
    res.json({ appointment });
  } catch (err) {
    next(err);
  }
});
