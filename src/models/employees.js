import { getDb } from '../config/db.js';

export const COLLECTION = 'employees';

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

const shiftSchema = {
  bsonType: 'object',
  required: ['start', 'end'],
  properties: {
    start: { bsonType: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' },
    end: { bsonType: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' },
  },
};

export const employeesJsonSchema = {
  $jsonSchema: {
    bsonType: 'object',
    required: ['name', 'workingHours', 'isActive', 'createdAt', 'updatedAt'],
    properties: {
      name: { bsonType: 'string', minLength: 1 },
      bio: { bsonType: ['string', 'null'] },
      photoUrl: { bsonType: ['string', 'null'] },
      // Per-weekday array of shifts, supporting split shifts (e.g. morning + afternoon).
      // An empty array for a day means the staff member doesn't work that day.
      workingHours: {
        bsonType: 'object',
        required: WEEKDAYS,
        properties: Object.fromEntries(WEEKDAYS.map((d) => [d, { bsonType: 'array', items: shiftSchema }])),
      },
      // null/absent = can perform every active service. A non-null array restricts this
      // staff member to those services only — used by "any available" staff selection.
      serviceIds: { bsonType: ['array', 'null'], items: { bsonType: 'objectId' } },
      isActive: { bsonType: 'bool' },
      createdAt: { bsonType: 'date' },
      updatedAt: { bsonType: 'date' },
    },
  },
};

export const employeesIndexes = [{ key: { isActive: 1 }, name: 'idx_active' }];

export function employeesCollection() {
  return getDb().collection(COLLECTION);
}

export function emptyWorkingHours() {
  return Object.fromEntries(WEEKDAYS.map((d) => [d, []]));
}
