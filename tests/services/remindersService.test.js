import { ObjectId } from 'mongodb';
import { setTestDb } from '../../src/config/db.js';
import { createFakeDb } from '../helpers/fakeDb.js';
import { appointmentsCollection } from '../../src/models/appointments.js';
import { usersCollection } from '../../src/models/users.js';
import { createTestService, createTestEmployee } from '../helpers/fixtures.js';
import { createUserAndToken } from '../helpers/testAuth.js';
import * as remindersService from '../../src/services/remindersService.js';
import { APPOINTMENT_STATUS, ROLES } from '../../src/config/constants.js';
import { BUSINESS_TZ_OFFSET_MINUTES, dateStringFor } from '../../src/utils/businessTime.js';

beforeEach(() => {
  setTestDb(createFakeDb());
});

// Formats a real instant N hours from now as the (date, startTime) business-tz wall-time
// strings appointments are stored as — the inverse of utils/businessTime.js's toInstant().
function wallTimeIn(hoursFromNow) {
  const instant = new Date(Date.now() + hoursFromNow * 3_600_000);
  const shifted = new Date(instant.getTime() + BUSINESS_TZ_OFFSET_MINUTES * 60_000);
  return {
    date: dateStringFor(instant),
    startTime: `${String(shifted.getUTCHours()).padStart(2, '0')}:${String(shifted.getUTCMinutes()).padStart(2, '0')}`,
  };
}

async function insertAppointment({ hoursFromNow, overrides = {} }) {
  const service = await createTestService();
  const employee = await createTestEmployee();
  const { date, startTime } = wallTimeIn(hoursFromNow);
  const now = new Date();
  const doc = {
    userId: null,
    guestInfo: { name: 'Guest Person', email: 'guest@example.com', phone: '0821234567' },
    employeeId: employee._id,
    serviceIds: [service._id],
    date,
    startTime,
    endTime: startTime,
    totalDurationMinutes: 60,
    totalPriceCents: service.priceCents,
    depositCents: 15000,
    isOffPeak: false,
    status: APPOINTMENT_STATUS.CONFIRMED,
    paymentId: null,
    notes: null,
    createdByAdminId: null,
    cancelledAt: null,
    cancelReason: null,
    reminderSentAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  const { insertedId } = await appointmentsCollection().insertOne(doc);
  return { ...doc, _id: insertedId };
}

describe('remindersService.sendDueReminders', () => {
  it('sends a reminder for a confirmed guest appointment inside the default 24h window and marks it sent', async () => {
    const appointment = await insertAppointment({ hoursFromNow: 10 });
    const result = await remindersService.sendDueReminders();
    expect(result.sent).toBe(1);
    const after = await appointmentsCollection().findOne({ _id: appointment._id });
    expect(after.reminderSentAt).toBeInstanceOf(Date);
  });

  it('does not send for an appointment further out than the reminder window', async () => {
    await insertAppointment({ hoursFromNow: 48 });
    const result = await remindersService.sendDueReminders();
    expect(result.sent).toBe(0);
  });

  it('does not send twice for the same appointment', async () => {
    await insertAppointment({ hoursFromNow: 5 });
    const first = await remindersService.sendDueReminders();
    expect(first.sent).toBe(1);
    const second = await remindersService.sendDueReminders();
    expect(second.sent).toBe(0);
  });

  it('does not send for a cancelled appointment even if it falls inside the window', async () => {
    await insertAppointment({ hoursFromNow: 5, overrides: { status: APPOINTMENT_STATUS.CANCELLED } });
    const result = await remindersService.sendDueReminders();
    expect(result.sent).toBe(0);
  });

  it('does not send for an appointment already in the past', async () => {
    await insertAppointment({ hoursFromNow: -2 });
    const result = await remindersService.sendDueReminders();
    expect(result.sent).toBe(0);
  });

  it('resolves the recipient from the user account for a logged-in booking, not just guests', async () => {
    const { userId } = await createUserAndToken({ role: ROLES.CUSTOMER });
    const user = await usersCollection().findOne({ _id: userId });
    expect(user.email).toEqual(expect.any(String));
    await insertAppointment({ hoursFromNow: 8, overrides: { userId, guestInfo: null } });
    const result = await remindersService.sendDueReminders();
    expect(result.sent).toBe(1);
  });

  it('skips a logged-in booking whose account no longer resolves to an email, without crashing the run', async () => {
    await insertAppointment({ hoursFromNow: 8, overrides: { userId: new ObjectId(), guestInfo: null } });
    const result = await remindersService.sendDueReminders();
    expect(result.sent).toBe(0);
  });
});
