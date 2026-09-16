import { getDb } from '../config/db.js';

export const COLLECTION = 'discountCodes';

export const DISCOUNT_TYPES = Object.freeze({ PERCENTAGE: 'percentage', FIXED: 'fixed' });
export const DISCOUNT_SOURCES = Object.freeze({ ADMIN: 'admin', REFERRAL: 'referral' });

export const discountCodesJsonSchema = {
  $jsonSchema: {
    bsonType: 'object',
    required: ['code', 'type', 'value', 'usageCount', 'usesRemaining', 'isActive', 'source', 'createdAt', 'updatedAt'],
    properties: {
      code: { bsonType: 'string' },
      type: { enum: Object.values(DISCOUNT_TYPES) },
      // percentage: 1-100. fixed: cents.
      value: { bsonType: 'int', minimum: 1 },
      minBookingAmountCents: { bsonType: ['int', 'null'], minimum: 0 },
      // usesRemaining (not usageLimit vs usageCount) is what the atomic redeem guard
      // checks directly — see discountsService.redeemDiscountCode() (§4.9/§6.1: usage-limit
      // enforcement must be a single atomic increment-and-check, not read-then-increment).
      // null = unlimited.
      usesRemaining: { bsonType: ['int', 'null'], minimum: 0 },
      usageCount: { bsonType: 'int', minimum: 0 },
      expiresAt: { bsonType: ['date', 'null'] },
      isActive: { bsonType: 'bool' },
      source: { enum: Object.values(DISCOUNT_SOURCES) },
      metadata: { bsonType: ['object', 'null'] },
      createdAt: { bsonType: 'date' },
      updatedAt: { bsonType: 'date' },
    },
  },
};

export const discountCodesIndexes = [{ key: { code: 1 }, unique: true, name: 'uniq_code' }];

export function discountCodesCollection() {
  return getDb().collection(COLLECTION);
}
