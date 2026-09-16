import { setTestDb } from '../../src/config/db.js';
import { createFakeDb } from '../helpers/fakeDb.js';
import { createTestService, createTestEmployee, futureDateString } from '../helpers/fixtures.js';
import * as bookingService from '../../src/services/bookingService.js';
import { appointmentsCollection, appointmentsIndexes } from '../../src/models/appointments.js';
import { availabilityCollection } from '../../src/models/availability.js';
import { ROLES } from '../../src/config/constants.js';
import { todayDateString, nowTimeString, addMinutesToTime } from '../../src/utils/businessTime.js';
import { ObjectId } from 'mongodb';

const DATE = futureDateString();

beforeEach(async () => {
  setTestDb(createFakeDb());
  // Registers the real unique partial index on the fake collection so the
  // double-booking guarantee is actually exercised, not just the app-level pre-check.
  await appointmentsCollection().createIndexes(appointmentsIndexes);
});

async function bookingActor(userId) {
  return { _id: userId, role: ROLES.CUSTOMER };
}

describe('bookingService.quoteBooking', () => {
  it('sums duration/price across services and flags off-peak surcharge', async () => {
    const service = await createTestService({ durationMinutes: 60, priceCents: 30000 });
    const quote = await bookingService.quoteBooking({ serviceIds: [String(service._id)], startTime: '18:00' });
    expect(quote.totalDurationMinutes).toBe(60);
    expect(quote.endTime).toBe('19:00');
    expect(quote.isOffPeak).toBe(true); // default settings: off-peak 17:00-20:00
    expect(quote.totalPriceCents).toBe(30000 + 5000); // + default off-peak surcharge
    expect(quote.depositCents).toBe(15000); // default deposit
  });

  it('is not off-peak outside the configured window', async () => {
    const service = await createTestService({ durationMinutes: 60, priceCents: 30000 });
    const quote = await bookingService.quoteBooking({ serviceIds: [String(service._id)], startTime: '10:00' });
    expect(quote.isOffPeak).toBe(false);
    expect(quote.totalPriceCents).toBe(30000);
  });

  it('rejects an inactive or unknown service', async () => {
    const service = await createTestService({ isActive: false });
    await expect(
      bookingService.quoteBooking({ serviceIds: [String(service._id)], startTime: '10:00' })
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('bookingService.createAppointment — the shared slot-validation path', () => {
  it('books a specific employee and computes price/deposit server-side', async () => {
    const service = await createTestService();
    const employee = await createTestEmployee();
    const userId = new ObjectId();

    const appointment = await bookingService.createAppointment({
      userId: String(userId),
      employeeId: String(employee._id),
      serviceIds: [String(service._id)],
      date: DATE,
      startTime: '10:00',
    });

    expect(appointment.status).toBe('pending_payment');
    expect(appointment.totalPriceCents).toBe(service.priceCents);
    expect(appointment.depositCents).toBe(15000);
  });

  it('books a guest with no userId', async () => {
    const service = await createTestService();
    const employee = await createTestEmployee();
    const appointment = await bookingService.createAppointment({
      guestInfo: { name: 'Guest', email: 'guest@example.com', phone: '0821234567' },
      employeeId: String(employee._id),
      serviceIds: [String(service._id)],
      date: DATE,
      startTime: '10:00',
    });
    expect(appointment.userId).toBeNull();
    expect(appointment.guestInfo.email).toBe('guest@example.com');
  });

  it('rejects a double-booking of the same employee/date/time', async () => {
    const service = await createTestService();
    const employee = await createTestEmployee();

    await bookingService.createAppointment({
      userId: String(new ObjectId()),
      employeeId: String(employee._id),
      serviceIds: [String(service._id)],
      date: DATE,
      startTime: '10:00',
    });

    await expect(
      bookingService.createAppointment({
        userId: String(new ObjectId()),
        employeeId: String(employee._id),
        serviceIds: [String(service._id)],
        date: DATE,
        startTime: '10:00',
      })
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('rejects an overlapping (not just identical) slot for the same employee', async () => {
    const service = await createTestService({ durationMinutes: 60 });
    const employee = await createTestEmployee();

    await bookingService.createAppointment({
      userId: String(new ObjectId()),
      employeeId: String(employee._id),
      serviceIds: [String(service._id)],
      date: DATE,
      startTime: '10:00', // occupies 10:00-11:00
    });

    await expect(
      bookingService.createAppointment({
        userId: String(new ObjectId()),
        employeeId: String(employee._id),
        serviceIds: [String(service._id)],
        date: DATE,
        startTime: '10:30', // overlaps 10:00-11:00
      })
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('rejects booking into an admin-blocked slot', async () => {
    const service = await createTestService({ durationMinutes: 60 });
    const employee = await createTestEmployee();
    await availabilityCollection().insertOne({
      employeeId: null, // salon-wide block
      date: DATE,
      startTime: '09:00',
      endTime: '11:00',
      reason: 'Deep clean',
      createdBy: new ObjectId(),
      createdAt: new Date(),
    });

    await expect(
      bookingService.createAppointment({
        userId: String(new ObjectId()),
        employeeId: String(employee._id),
        serviceIds: [String(service._id)],
        date: DATE,
        startTime: '10:00',
      })
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('"any available" resolves to a free employee when the first choice is busy', async () => {
    const service = await createTestService({ durationMinutes: 60 });
    const busyEmployee = await createTestEmployee({ name: 'Busy' });
    const freeEmployee = await createTestEmployee({ name: 'Free' });

    await bookingService.createAppointment({
      userId: String(new ObjectId()),
      employeeId: String(busyEmployee._id),
      serviceIds: [String(service._id)],
      date: DATE,
      startTime: '10:00',
    });

    const appointment = await bookingService.createAppointment({
      userId: String(new ObjectId()),
      employeeId: 'any',
      serviceIds: [String(service._id)],
      date: DATE,
      startTime: '10:00',
    });

    expect(String(appointment.employeeId)).toBe(String(freeEmployee._id));
  });

  it('two concurrent bookings for the same slot: only one wins (atomic write guard)', async () => {
    const service = await createTestService();
    const employee = await createTestEmployee();

    const attempt = () =>
      bookingService.createAppointment({
        userId: String(new ObjectId()),
        employeeId: String(employee._id),
        serviceIds: [String(service._id)],
        date: DATE,
        startTime: '14:00',
      });

    const results = await Promise.allSettled([attempt(), attempt()]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason.statusCode).toBe(409);
  });
});

describe('bookingService.cancelAppointment — server-side cancellation window', () => {
  it('blocks a customer cancelling within the notice window, but allows admin', async () => {
    const service = await createTestService({ durationMinutes: 60 });
    const employee = await createTestEmployee();
    const userId = new ObjectId();

    // Scheduled 1 hour from now — inside the default 24h cancellation notice window.
    const soonStart = addMinutesToTime(nowTimeString(), 60);
    const appointment = await appointmentsCollection().insertOne({
      userId,
      guestInfo: null,
      employeeId: employee._id,
      serviceIds: [service._id],
      date: todayDateString(),
      startTime: soonStart,
      endTime: addMinutesToTime(soonStart, 60),
      totalDurationMinutes: 60,
      totalPriceCents: service.priceCents,
      depositCents: 15000,
      isOffPeak: false,
      status: 'confirmed',
      paymentId: null,
      notes: null,
      createdByAdminId: null,
      cancelledAt: null,
      cancelReason: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await expect(
      bookingService.cancelAppointment({
        appointmentId: appointment.insertedId,
        actor: await bookingActor(userId),
        reason: 'Changed my mind',
      })
    ).rejects.toMatchObject({ statusCode: 400 });

    const cancelled = await bookingService.cancelAppointment({
      appointmentId: appointment.insertedId,
      actor: { _id: new ObjectId(), role: ROLES.ADMIN },
      reason: 'Client called in',
    });
    expect(cancelled.status).toBe('cancelled');
  });

  it('allows a customer to cancel well outside the notice window', async () => {
    const service = await createTestService();
    const employee = await createTestEmployee();
    const userId = new ObjectId();

    const appointment = await bookingService.createAppointment({
      userId: String(userId),
      employeeId: String(employee._id),
      serviceIds: [String(service._id)],
      date: DATE,
      startTime: '10:00',
    });

    const cancelled = await bookingService.cancelAppointment({
      appointmentId: appointment._id,
      actor: await bookingActor(userId),
    });
    expect(cancelled.status).toBe('cancelled');
  });

  it('rejects access from a user who does not own the appointment', async () => {
    const service = await createTestService();
    const employee = await createTestEmployee();
    const owner = new ObjectId();
    const stranger = new ObjectId();

    const appointment = await bookingService.createAppointment({
      userId: String(owner),
      employeeId: String(employee._id),
      serviceIds: [String(service._id)],
      date: DATE,
      startTime: '10:00',
    });

    await expect(
      bookingService.cancelAppointment({ appointmentId: appointment._id, actor: await bookingActor(stranger) })
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('bookingService.rescheduleAppointment', () => {
  it('moves the appointment to a new free slot and recomputes price', async () => {
    const service = await createTestService({ durationMinutes: 60, priceCents: 20000 });
    const employee = await createTestEmployee();
    const userId = new ObjectId();

    const appointment = await bookingService.createAppointment({
      userId: String(userId),
      employeeId: String(employee._id),
      serviceIds: [String(service._id)],
      date: DATE,
      startTime: '10:00',
    });

    const rescheduled = await bookingService.rescheduleAppointment({
      appointmentId: appointment._id,
      date: DATE,
      startTime: '18:00', // off-peak window
      actor: await bookingActor(userId),
    });

    expect(rescheduled.startTime).toBe('18:00');
    expect(rescheduled.isOffPeak).toBe(true);
    expect(rescheduled.totalPriceCents).toBe(20000 + 5000);
  });

  it('rejects rescheduling into a slot already taken by someone else', async () => {
    const service = await createTestService({ durationMinutes: 60 });
    const employee = await createTestEmployee();
    const userA = new ObjectId();
    const userB = new ObjectId();

    await bookingService.createAppointment({
      userId: String(userA),
      employeeId: String(employee._id),
      serviceIds: [String(service._id)],
      date: DATE,
      startTime: '09:00',
    });
    const appointmentB = await bookingService.createAppointment({
      userId: String(userB),
      employeeId: String(employee._id),
      serviceIds: [String(service._id)],
      date: DATE,
      startTime: '12:00',
    });

    await expect(
      bookingService.rescheduleAppointment({
        appointmentId: appointmentB._id,
        date: DATE,
        startTime: '09:00',
        actor: await bookingActor(userB),
      })
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('bookingService.listAvailableSlots', () => {
  it('excludes a slot once it is booked and reflects it again once cancelled', async () => {
    const service = await createTestService({ durationMinutes: 60 });
    const employee = await createTestEmployee({
      workingHours: {
        mon: [{ start: '09:00', end: '12:00' }],
        tue: [{ start: '09:00', end: '12:00' }],
        wed: [{ start: '09:00', end: '12:00' }],
        thu: [{ start: '09:00', end: '12:00' }],
        fri: [{ start: '09:00', end: '12:00' }],
        sat: [{ start: '09:00', end: '12:00' }],
        sun: [{ start: '09:00', end: '12:00' }],
      },
    });

    const before = await bookingService.listAvailableSlots({
      serviceIds: [String(service._id)],
      date: DATE,
      employeeId: String(employee._id),
    });
    expect(before).toContain('10:00');

    const appointment = await bookingService.createAppointment({
      userId: String(new ObjectId()),
      employeeId: String(employee._id),
      serviceIds: [String(service._id)],
      date: DATE,
      startTime: '10:00',
    });

    const during = await bookingService.listAvailableSlots({
      serviceIds: [String(service._id)],
      date: DATE,
      employeeId: String(employee._id),
    });
    expect(during).not.toContain('10:00');

    await bookingService.cancelAppointment({
      appointmentId: appointment._id,
      actor: { _id: new ObjectId(), role: ROLES.ADMIN },
    });

    const after = await bookingService.listAvailableSlots({
      serviceIds: [String(service._id)],
      date: DATE,
      employeeId: String(employee._id),
    });
    expect(after).toContain('10:00');
  });
});
