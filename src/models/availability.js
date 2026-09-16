import { getDb } from '../config/db.js';

export const COLLECTION = 'availability';

// Admin-blocked time slots (§4.3) — either salon-wide (employeeId: null) or scoped to
// one staff member. Dates/times are stored as explicit strings, never as a Date object
// read with local-timezone getters (§6.5), so this behaves the same regardless of the
// server process's TZ.
export const availabilityJsonSchema = {
  $jsonSchema: {
    bsonType: 'object',
    required: ['employeeId', 'date', 'startTime', 'endTime', 'createdBy', 'createdAt'],
    properties: {
      employeeId: { bsonType: ['objectId', 'null'] },
      date: { bsonType: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      startTime: { bsonType: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' },
      endTime: { bsonType: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' },
      reason: { bsonType: ['string', 'null'] },
      createdBy: { bsonType: 'objectId' },
      createdAt: { bsonType: 'date' },
    },
  },
};

export const availabilityIndexes = [
  { key: { employeeId: 1, date: 1 }, name: 'idx_employee_date' },
  { key: { date: 1 }, name: 'idx_date' },
];

export function availabilityCollection() {
  return getDb().collection(COLLECTION);
}
