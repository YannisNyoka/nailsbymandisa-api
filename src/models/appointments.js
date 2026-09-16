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
      createdAt: { bsonType: 'date' },
      updatedAt: { bsonType: 'date' },
    },
  },
};

// Partial unique index — only one pending/confirmed appointment can occupy a given
// (date, employeeId, startTime). Cancelled/completed/no-show rows are excluded so
// history never blocks a new booking, but this is what makes double-booking impossible
// at the database level rather than relying solely on the application-level check (§3, §4.3).
export const appointmentsIndexes = [
  {
    key: { date: 1, employeeId: 1, startTime: 1 },
    unique: true,
    name: 'uniq_active_slot',
    partialFilterExpression: {
      status: { $in: [APPOINTMENT_STATUS.PENDING_PAYMENT, APPOINTMENT_STATUS.CONFIRMED] },
    },
  },
  { key: { userId: 1, date: -1 }, name: 'idx_user_date' },
  { key: { employeeId: 1, date: 1 }, name: 'idx_employee_date' },
  { key: { date: 1 }, name: 'idx_date' },
];

export function appointmentsCollection() {
  return getDb().collection(COLLECTION);
}

export const DUPLICATE_KEY_ERROR_CODE = 11000;
