import { getDb } from '../config/db.js';

export const COLLECTION = 'subscriptions';

export const SUBSCRIPTION_STATUS = Object.freeze({
  PENDING: 'pending', // created, awaiting first payment
  ACTIVE: 'active',
  CANCELLED: 'cancelled',
});

export const subscriptionsJsonSchema = {
  $jsonSchema: {
    bsonType: 'object',
    required: ['userId', 'planId', 'status', 'creditsRemaining', 'currentPeriodEnd', 'createdAt', 'updatedAt'],
    properties: {
      userId: { bsonType: 'objectId' },
      planId: { bsonType: 'objectId' },
      status: { enum: Object.values(SUBSCRIPTION_STATUS) },
      // Atomically decremented at booking time (subscriptionsService.useCredit) — the
      // same floor-checked findOneAndUpdate pattern as loyalty/gift-card balances.
      creditsRemaining: { bsonType: 'int', minimum: 0 },
      currentPeriodEnd: { bsonType: ['date', 'null'] },
      paymentId: { bsonType: ['objectId', 'null'] },
      createdAt: { bsonType: 'date' },
      updatedAt: { bsonType: 'date' },
      cancelledAt: { bsonType: ['date', 'null'] },
    },
  },
};

export const subscriptionsIndexes = [
  // One subscription document per user — cancelling and resubscribing reuses/updates it
  // rather than creating a second row, so this stays a hard invariant, not just a
  // business rule enforced in application code.
  { key: { userId: 1 }, unique: true, name: 'uniq_user' },
  { key: { planId: 1 }, name: 'idx_plan' },
];

export function subscriptionsCollection() {
  return getDb().collection(COLLECTION);
}
