import { getDb } from '../config/db.js';

export const COLLECTION = 'subscriptionPlans';

export const subscriptionPlansJsonSchema = {
  $jsonSchema: {
    bsonType: 'object',
    required: ['name', 'description', 'priceCents', 'creditsPerPeriod', 'periodDays', 'isActive', 'createdAt', 'updatedAt'],
    properties: {
      name: { bsonType: 'string', minLength: 1 },
      description: { bsonType: ['string', 'null'] },
      priceCents: { bsonType: 'int', minimum: 1 },
      // A credit fully covers one booking's deposit (§4.8 "credits usable against any
      // booking") — simpler and more general than "N bookings/month at a discount",
      // and the two converge when a credit maps 1:1 to a booking's deposit anyway.
      creditsPerPeriod: { bsonType: 'int', minimum: 1 },
      periodDays: { bsonType: 'int', minimum: 1 },
      isActive: { bsonType: 'bool' },
      createdAt: { bsonType: 'date' },
      updatedAt: { bsonType: 'date' },
    },
  },
};

export const subscriptionPlansIndexes = [{ key: { isActive: 1 }, name: 'idx_active' }];

export function subscriptionPlansCollection() {
  return getDb().collection(COLLECTION);
}
