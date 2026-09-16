import { getDb } from '../config/db.js';

export const COLLECTION = 'referrals';

export const REFERRAL_STATUS = Object.freeze({ PENDING: 'pending', COMPLETED: 'completed' });

export const referralsJsonSchema = {
  $jsonSchema: {
    bsonType: 'object',
    required: ['referrerUserId', 'referredUserId', 'code', 'status', 'createdAt'],
    properties: {
      referrerUserId: { bsonType: 'objectId' },
      referredUserId: { bsonType: 'objectId' },
      code: { bsonType: 'string' },
      status: { enum: Object.values(REFERRAL_STATUS) },
      discountCodeId: { bsonType: ['objectId', 'null'] },
      createdAt: { bsonType: 'date' },
      completedAt: { bsonType: ['date', 'null'] },
    },
  },
};

export const referralsIndexes = [
  { key: { referredUserId: 1 }, unique: true, name: 'uniq_referred_user' },
  { key: { referrerUserId: 1 }, name: 'idx_referrer' },
];

export function referralsCollection() {
  return getDb().collection(COLLECTION);
}
