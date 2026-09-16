import { ObjectId } from 'mongodb';
import { appointmentsCollection, DUPLICATE_KEY_ERROR_CODE } from '../models/appointments.js';
import { availabilityCollection } from '../models/availability.js';
import { servicesCollection } from '../models/services.js';
import { employeesCollection } from '../models/employees.js';
import { getSettings } from './settingsService.js';
import { createClientNotification } from './clientNotificationsService.js';
import { logActivity } from './activityLogService.js';
import { APPOINTMENT_STATUS, ANY_AVAILABLE_EMPLOYEE, SLOT_GRANULARITY_MINUTES } from '../config/constants.js';
import {
  weekdayKeyForDate,
  toInstant,
  nowInBusinessTz,
  addMinutesToTime,
  hoursBetween,
  timeRangesOverlap,
} from '../utils/businessTime.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../utils/AppError.js';

const ACTIVE_STATUSES = [APPOINTMENT_STATUS.PENDING_PAYMENT, APPOINTMENT_STATUS.CONFIRMED];

// ============================================================================
// THE single shared slot-validation rule (§4.3). Every path that can create or move a
// booking — new booking, guest booking, admin-created booking, reschedule — goes
// through checkSlotBookable() (via createAppointment/rescheduleAppointment below), and
// the slot-picker (listAvailableSlots) evaluates candidate slots with this exact same
// rule, just fed pre-fetched data instead of querying per candidate. Do not duplicate
// this logic — extend evaluateSlot() if the rule itself needs to change.
// ============================================================================
function evaluateSlot({ employee, date, startTime, endTime, blocksForDay, appointmentsForDay, excludeAppointmentId }) {
  if (!employee || !employee.isActive) {
    return { bookable: false, reason: 'This staff member is not available for booking.' };
  }

  const shifts = employee.workingHours?.[weekdayKeyForDate(date)] ?? [];
  const withinWorkingHours = shifts.some((shift) => shift.start <= startTime && shift.end >= endTime);
  if (!withinWorkingHours) {
    return { bookable: false, reason: 'This staff member does not work that day/time.' };
  }

  if (toInstant(date, startTime) <= nowInBusinessTz()) {
    return { bookable: false, reason: 'This slot is in the past.' };
  }

  const relevantBlocks = blocksForDay.filter(
    (b) => b.employeeId === null || String(b.employeeId) === String(employee._id)
  );
  const blockingBlock = relevantBlocks.find((b) => timeRangesOverlap(startTime, endTime, b.startTime, b.endTime));
  if (blockingBlock) {
    return { bookable: false, reason: 'This slot has been blocked off.' };
  }

  const conflictingAppointment = appointmentsForDay.find(
    (a) =>
      ACTIVE_STATUSES.includes(a.status) &&
      String(a._id) !== String(excludeAppointmentId) &&
      timeRangesOverlap(startTime, endTime, a.startTime, a.endTime)
  );
  if (conflictingAppointment) {
    return { bookable: false, reason: 'This slot has just been booked.' };
  }

  return { bookable: true };
}

// Single-slot check: fetches just what evaluateSlot() needs for one (employee, date)
// pair — one query for the day's blocks, one for the day's appointments (§6.3).
export async function checkSlotBookable({ employeeId, date, startTime, endTime, excludeAppointmentId }) {
  const employee = await employeesCollection().findOne({ _id: new ObjectId(employeeId) });
  const [blocksForDay, appointmentsForDay] = await Promise.all([
    (await availabilityCollection().find({ date })).toArray(),
    (await appointmentsCollection().find({ employeeId: new ObjectId(employeeId), date })).toArray(),
  ]);
  return evaluateSlot({ employee, date, startTime, endTime, blocksForDay, appointmentsForDay, excludeAppointmentId });
}

async function loadActiveServices(serviceIds) {
  if (!serviceIds?.length) throw badRequest('At least one service must be selected.');
  const ids = serviceIds.map((id) => new ObjectId(id));
  const services = await (await servicesCollection().find({ _id: { $in: ids }, isActive: true })).toArray();
  if (services.length !== serviceIds.length) {
    throw badRequest('One or more selected services are unavailable.');
  }
  return services;
}

function isOffPeakStart(startTime, offPeakHours) {
  return (offPeakHours || []).some((range) => startTime >= range.start && startTime < range.end);
}

// §5.1 — the server computes every price. This is the only function in the codebase
// allowed to decide what a booking costs; nothing else may accept a client-submitted
// totalPriceCents/depositCents.
export async function quoteBooking({ serviceIds, startTime }) {
  const [services, settings] = await Promise.all([loadActiveServices(serviceIds), getSettings()]);

  const totalDurationMinutes = services.reduce((sum, s) => sum + s.durationMinutes, 0);
  const endTime = addMinutesToTime(startTime, totalDurationMinutes);
  const isOffPeak = isOffPeakStart(startTime, settings.offPeakHours);
  const servicesPriceCents = services.reduce((sum, s) => sum + s.priceCents, 0);
  const totalPriceCents = servicesPriceCents + (isOffPeak ? settings.offPeakSurchargeCents : 0);

  return {
    services,
    totalDurationMinutes,
    endTime,
    isOffPeak,
    totalPriceCents,
    depositCents: settings.bookingDepositCents,
  };
}

function employeeCanPerform(employee, serviceObjectIds) {
  return !employee.serviceIds || serviceObjectIds.every((sid) => employee.serviceIds.some((eid) => String(eid) === String(sid)));
}

async function resolveEmployee({ employeeId, serviceIds, date, startTime, endTime }) {
  if (employeeId && employeeId !== ANY_AVAILABLE_EMPLOYEE) {
    const result = await checkSlotBookable({ employeeId, date, startTime, endTime });
    if (!result.bookable) throw conflict(result.reason);
    return employeeId;
  }

  const serviceObjectIds = serviceIds.map((id) => new ObjectId(id));
  const candidates = await (await employeesCollection().find({ isActive: true })).toArray();
  const capable = candidates.filter((e) => employeeCanPerform(e, serviceObjectIds));

  for (const employee of capable) {
    // eslint-disable-next-line no-await-in-loop -- sequential by design: stop at the first bookable candidate
    const result = await checkSlotBookable({ employeeId: employee._id, date, startTime, endTime });
    if (result.bookable) return String(employee._id);
  }
  throw conflict('No staff are available for that slot. Please choose a different time.');
}

// The single creation path for every entry point — public guest wizard, logged-in
// dashboard, and admin-created bookings all call this (§4.3). Identity is the only
// thing that varies between callers; the validation/pricing logic never forks.
export async function createAppointment({ userId, guestInfo, employeeId, serviceIds, date, startTime, notes, createdByAdminId }) {
  if (!userId && !guestInfo) throw badRequest('Either an account or guest contact details are required.');

  const quote = await quoteBooking({ serviceIds, date, startTime });
  const resolvedEmployeeId = await resolveEmployee({
    employeeId,
    serviceIds,
    date,
    startTime,
    endTime: quote.endTime,
  });

  const now = new Date();
  const doc = {
    userId: userId ? new ObjectId(userId) : null,
    guestInfo: userId ? null : guestInfo,
    employeeId: new ObjectId(resolvedEmployeeId),
    serviceIds: serviceIds.map((id) => new ObjectId(id)),
    date,
    startTime,
    endTime: quote.endTime,
    totalDurationMinutes: quote.totalDurationMinutes,
    totalPriceCents: quote.totalPriceCents,
    depositCents: quote.depositCents,
    isOffPeak: quote.isOffPeak,
    status: APPOINTMENT_STATUS.PENDING_PAYMENT,
    paymentId: null,
    notes: notes ?? null,
    createdByAdminId: createdByAdminId ? new ObjectId(createdByAdminId) : null,
    cancelledAt: null,
    cancelReason: null,
    createdAt: now,
    updatedAt: now,
  };

  try {
    const { insertedId } = await appointmentsCollection().insertOne(doc);
    await logActivity({
      type: 'booking_created',
      message: `New booking on ${date} at ${startTime}${createdByAdminId ? ' (created by admin)' : ''}`,
      actorUserId: createdByAdminId ?? userId ?? null,
      metadata: { appointmentId: String(insertedId) },
    });
    return { ...doc, _id: insertedId };
  } catch (err) {
    // Atomic re-check at the moment of write (§4.3): the unique partial index is the
    // real guard against two concurrent requests both winning the same slot — the
    // checkSlotBookable() call above is a fast-fail for the common case, not the source
    // of truth. A race that slips past it is caught here as a duplicate-key error.
    if (err.code === DUPLICATE_KEY_ERROR_CODE) {
      throw conflict('This slot was just booked by someone else. Please choose another time.');
    }
    throw err;
  }
}

function assertOwnerOrAdmin(appointment, actor) {
  if (actor.role === 'admin') return;
  if (!appointment.userId || String(appointment.userId) !== String(actor._id)) {
    throw forbidden('You do not have access to this appointment.');
  }
}

export async function getAppointment(id) {
  const appointment = await appointmentsCollection().findOne({ _id: new ObjectId(id) });
  if (!appointment) throw notFound('Appointment');
  return appointment;
}

// §4.3 — reschedule/cancel windows are enforced server-side, not just as UI copy.
// Admins bypass both windows (they're the ones granting the exception on request).
export async function rescheduleAppointment({ appointmentId, date, startTime, actor }) {
  const appointment = await getAppointment(appointmentId);
  assertOwnerOrAdmin(appointment, actor);

  if (!ACTIVE_STATUSES.includes(appointment.status)) {
    throw badRequest('Only pending or confirmed appointments can be rescheduled.');
  }

  if (actor.role !== 'admin') {
    const settings = await getSettings();
    const hoursUntilCurrentSlot = hoursBetween(nowInBusinessTz(), toInstant(appointment.date, appointment.startTime));
    if (hoursUntilCurrentSlot < settings.rescheduleLockoutHours) {
      throw new AppError(
        `Appointments can't be rescheduled within ${settings.rescheduleLockoutHours} hours of the start time.`,
        400
      );
    }
  }

  const quote = await quoteBooking({ serviceIds: appointment.serviceIds, date, startTime });
  const check = await checkSlotBookable({
    employeeId: appointment.employeeId,
    date,
    startTime,
    endTime: quote.endTime,
    excludeAppointmentId: appointment._id,
  });
  if (!check.bookable) throw conflict(check.reason);

  try {
    await appointmentsCollection().updateOne(
      { _id: appointment._id },
      {
        $set: {
          date,
          startTime,
          endTime: quote.endTime,
          totalPriceCents: quote.totalPriceCents,
          isOffPeak: quote.isOffPeak,
          updatedAt: new Date(),
        },
      }
    );
  } catch (err) {
    if (err.code === DUPLICATE_KEY_ERROR_CODE) {
      throw conflict('This slot was just booked by someone else. Please choose another time.');
    }
    throw err;
  }

  return getAppointment(appointmentId);
}

export async function cancelAppointment({ appointmentId, actor, reason }) {
  const appointment = await getAppointment(appointmentId);
  assertOwnerOrAdmin(appointment, actor);

  if (!ACTIVE_STATUSES.includes(appointment.status)) {
    throw badRequest('This appointment has already been cancelled or completed.');
  }

  if (actor.role !== 'admin') {
    const settings = await getSettings();
    const hoursUntilSlot = hoursBetween(nowInBusinessTz(), toInstant(appointment.date, appointment.startTime));
    if (hoursUntilSlot < settings.cancellationNoticeHours) {
      throw new AppError(
        `Appointments can't be cancelled within ${settings.cancellationNoticeHours} hours of the start time.`,
        400
      );
    }
  }

  await appointmentsCollection().updateOne(
    { _id: appointment._id },
    {
      $set: {
        status: APPOINTMENT_STATUS.CANCELLED,
        cancelledAt: new Date(),
        cancelReason: reason ?? null,
        updatedAt: new Date(),
      },
    }
  );

  await logActivity({
    type: 'booking_cancelled',
    message: `Booking on ${appointment.date} at ${appointment.startTime} cancelled${actor.role === 'admin' ? ' by admin' : ''}`,
    actorUserId: actor._id,
    metadata: { appointmentId: String(appointment._id), reason: reason ?? null },
  });

  if (appointment.userId) {
    await createClientNotification({
      userId: appointment.userId,
      type: 'booking_cancelled',
      title: 'Booking cancelled',
      body: `Your booking on ${appointment.date} at ${appointment.startTime} has been cancelled.`,
      link: `/account/bookings/${appointment._id}`,
    });
  }

  return getAppointment(appointmentId);
}

// Powers the slot picker (§4.3): fetches each day's blocks/appointments ONCE per
// employee (not once per candidate slot) and evaluates every SLOT_GRANULARITY_MINUTES
// candidate in-memory via the same evaluateSlot() rule createAppointment ultimately
// checks against — batched per §6.3, not diverging per §6.2.
export async function listAvailableSlots({ serviceIds, date, employeeId }) {
  const quote = await quoteBooking({ serviceIds, date, startTime: '00:00' });
  const durationMinutes = quote.totalDurationMinutes;

  const employees =
    employeeId && employeeId !== ANY_AVAILABLE_EMPLOYEE
      ? [await employeesCollection().findOne({ _id: new ObjectId(employeeId) })].filter(Boolean)
      : await (await employeesCollection().find({ isActive: true })).toArray();

  const serviceObjectIds = serviceIds.map((id) => new ObjectId(id));
  const capableEmployees = employees.filter((e) => e.isActive && employeeCanPerform(e, serviceObjectIds));
  if (capableEmployees.length === 0) return [];

  const blocksForDay = await (await availabilityCollection().find({ date })).toArray();

  const slotsByTime = new Set();

  for (const employee of capableEmployees) {
    // eslint-disable-next-line no-await-in-loop -- one query per employee for the day, not per candidate slot
    const appointmentsForDay = await (
      await appointmentsCollection().find({ employeeId: employee._id, date })
    ).toArray();

    const shifts = employee.workingHours?.[weekdayKeyForDate(date)] ?? [];
    for (const shift of shifts) {
      for (
        let t = shift.start;
        addMinutesToTime(t, durationMinutes) <= shift.end;
        t = addMinutesToTime(t, SLOT_GRANULARITY_MINUTES)
      ) {
        const endTime = addMinutesToTime(t, durationMinutes);
        const result = evaluateSlot({ employee, date, startTime: t, endTime, blocksForDay, appointmentsForDay });
        if (result.bookable) slotsByTime.add(t);
      }
    }
  }

  return [...slotsByTime].sort();
}
