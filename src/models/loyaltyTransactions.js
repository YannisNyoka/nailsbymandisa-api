import { getDb } from '../config/db.js';

export const COLLECTION = 'loyaltyTransactions';

export const LOYALTY_TRANSACTION_TYPES = Object.freeze({
  EARN: 'earn',
  REDEEM: 'redeem',
  ADJUST: 'adjust',
});

export const loyaltyTransactionsJsonSchema = {
  $jsonSchema: {
    bsonType: 'object',
    required: ['userId', 'type', 'points', 'balanceAfter', 'source', 'createdAt'],
    properties: {
      userId: { bsonType: 'objectId' },
      type: { enum: Object.values(LOYALTY_TRANSACTION_TYPES) },
      // Signed: positive for earn/positive adjustment, negative for redeem/negative adjustment.
      points: { bsonType: 'int' },
      balanceAfter: { bsonType: 'int', minimum: 0 },
      source: { bsonType: 'string' },
      relatedPaymentId: { bsonType: ['objectId', 'null'] },
      relatedAppointmentId: { bsonType: ['objectId', 'null'] },
      note: { bsonType: ['string', 'null'] },
      createdAt: { bsonType: 'date' },
    },
  },
};

export const loyaltyTransactionsIndexes = [{ key: { userId: 1, createdAt: -1 }, name: 'idx_user_created' }];

export function loyaltyTransactionsCollection() {
  return getDb().collection(COLLECTION);
}
