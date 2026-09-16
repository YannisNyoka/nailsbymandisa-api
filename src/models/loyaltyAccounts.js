import { getDb } from '../config/db.js';

export const COLLECTION = 'loyaltyAccounts';

export const loyaltyAccountsJsonSchema = {
  $jsonSchema: {
    bsonType: 'object',
    required: ['userId', 'pointsBalance', 'lifetimePointsEarned', 'createdAt', 'updatedAt'],
    properties: {
      userId: { bsonType: 'objectId' },
      pointsBalance: { bsonType: 'int', minimum: 0 },
      // Tier is derived from this at read time (settings.loyalty.tiers), not stored —
      // it never decreases even as pointsBalance is spent down.
      lifetimePointsEarned: { bsonType: 'int', minimum: 0 },
      createdAt: { bsonType: 'date' },
      updatedAt: { bsonType: 'date' },
    },
  },
};

export const loyaltyAccountsIndexes = [{ key: { userId: 1 }, unique: true, name: 'uniq_user' }];

export function loyaltyAccountsCollection() {
  return getDb().collection(COLLECTION);
}
