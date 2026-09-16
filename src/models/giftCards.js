import { getDb } from '../config/db.js';

export const COLLECTION = 'giftCards';

export const GIFT_CARD_STATUS = Object.freeze({
  PENDING: 'pending', // created, awaiting payment
  ACTIVE: 'active', // paid — balanceCents is spendable
  CANCELLED: 'cancelled',
});

const redemptionEntrySchema = {
  bsonType: 'object',
  required: ['amountCents', 'createdAt'],
  properties: {
    amountCents: { bsonType: 'int', minimum: 0 },
    appointmentId: { bsonType: ['objectId', 'null'] },
    createdAt: { bsonType: 'date' },
  },
};

export const giftCardsJsonSchema = {
  $jsonSchema: {
    bsonType: 'object',
    required: [
      'code',
      'initialAmountCents',
      'balanceCents',
      'status',
      'purchasedByUserId',
      'purchaserEmail',
      'recipientEmail',
      'paymentId',
      'redemptions',
      'createdAt',
      'updatedAt',
    ],
    properties: {
      code: { bsonType: 'string' },
      initialAmountCents: { bsonType: 'int', minimum: 1 },
      // §4.7 — the balance a redemption checks and decrements atomically in the same
      // operation (giftCardsService.redeemUpTo) — never read-then-write separately.
      balanceCents: { bsonType: 'int', minimum: 0 },
      status: { enum: Object.values(GIFT_CARD_STATUS) },
      purchasedByUserId: { bsonType: ['objectId', 'null'] },
      purchaserEmail: { bsonType: 'string' },
      recipientEmail: { bsonType: ['string', 'null'] },
      paymentId: { bsonType: ['objectId', 'null'] },
      redemptions: { bsonType: 'array', items: redemptionEntrySchema },
      createdAt: { bsonType: 'date' },
      updatedAt: { bsonType: 'date' },
    },
  },
};

export const giftCardsIndexes = [
  { key: { code: 1 }, unique: true, name: 'uniq_code' },
  { key: { purchasedByUserId: 1 }, name: 'idx_purchaser' },
];

export function giftCardsCollection() {
  return getDb().collection(COLLECTION);
}
