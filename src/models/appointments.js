import { getDb } from '../config/db.js';
import { APPOINTMENT_STATUS } from '../config/constants.js';

export const COLLECTION = 'appointments';

export const appointmentsJsonSchema = {
  $jsonSchema: {
    bsonType: 'object',
    required: [
      'userId',
      'guestInfo',
      'employeeId',
      'serviceIds',
      'date',
      'startTime',
      'endTime',
      'totalDurationMinutes',
      'totalPriceCents',
      'depositCents',
      'isOffPeak',
      'status',
      'createdAt',
      'updatedAt',
    ],
    properties: {
      userId: { bsonType: ['objectId', 'null'] },
      guestInfo: {
        bsonType: ['object', 'null'],
        required: ['name', 'email', 'phone'],
        properties: {
          name: { bsonType: 'string' },
          email: { bsonType: 'string' },
          phone: { bsonType: 'string' },
        },
      },
      employeeId: { bsonType: 'objectId' },
      serviceIds: { bsonType: 'array', items: { bsonType: 'objectId' }, minItems: 1 },
      date: { bsonType: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      startTime: { bsonType: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' },
      endTime: { bsonType: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' },
      totalDurationMinutes: { bsonType: 'int', minimum: 5 },
      // Every money field here is server-computed at write time — never accepted from
      // the client — see bookingService.quoteBooking() (§5.1).
      totalPriceCents: { bsonType: 'int', minimum: 0 },
      depositCents: { bsonType: 'int', minimum: 0 },
      isOffPeak: { bsonType: 'bool' },
      status: { enum: Object.values(APPOINTMENT_STATUS) },
      paymentId: { bsonType: ['objectId', 'null'] },
      notes: { bsonType: ['string', 'null'] },
      createdByAdminId: { bsonType: ['objectId', 'null'] },
      cancelledAt: { bsonType: ['date', 'null'] },
      cancelReason: { bsonType: ['string', 'null'] },
      // Set once the reminder email has gone out (services/remindersService.js) — the
      // guard that makes the reminders job idempotent no matter how often it runs. Not in
      // `required` for forward-compat with documents predating this field.
      reminderSentAt: { bsonType: ['date', 'null'] },
      // Only meaningful while status is pending_payment — a pending appointment never
      // blocks its slot for anyone else (see bookingService.js's evaluateSlot), so this
      // isn't about freeing the slot. It's the deadline after which an abandoned,
      // never-paid appointment gets auto-cancelled for hygiene (bookingService's
      // expireDueUnpaidAppointments). Not in `required` for forward-compat with documents
      // predating this field.
      autoExpireAt: { bsonType: ['date', 'null'] },
      createdAt: { bsonType: 'date' },
      updatedAt: { bsonType: 'date' },
    },
  },
};

// Partial unique index — only one CONFIRMED (i.e. paid) appointment can occupy a given
// (date, employeeId, startTime). Deliberately excludes pending_payment: only a paid
// appointment holds its slot, so two people can each hold a pending appointment for the
// same slot at once (whoever pays first wins it; see paymentsService.js's
// confirmAppointmentForPaidDeposit for how the loser is handled) — this index is what
// makes "only one CONFIRMED booking per slot" impossible to violate at the database
// level, rather than relying solely on the application-level check (§3, §4.3).
export const appointmentsIndexes = [
  {
    key: { date: 1, employeeId: 1, startTime: 1 },
    unique: true,
    name: 'uniq_active_slot',
    partialFilterExpression: { status: APPOINTMENT_STATUS.CONFIRMED },
  },
  { key: { userId: 1, date: -1 }, name: 'idx_user_date' },
  { key: { employeeId: 1, date: 1 }, name: 'idx_employee_date' },
  { key: { date: 1 }, name: 'idx_date' },
  // Candidate-set filter for the reminders job (services/remindersService.js) — confirmed,
  // not yet reminded, ordered by date so the query can range-scan a small upcoming window.
  {
    key: { status: 1, reminderSentAt: 1, date: 1 },
    name: 'idx_reminder_candidates',
    partialFilterExpression: { status: APPOINTMENT_STATUS.CONFIRMED },
  },
];

export function appointmentsCollection() {
  return getDb().collection(COLLECTION);
}

export const DUPLICATE_KEY_ERROR_CODE = 11000;
