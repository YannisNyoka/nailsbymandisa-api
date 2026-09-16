import { getDb } from '../config/db.js';
import { PAYMENT_STATUS, PAYMENT_PURPOSE } from '../config/constants.js';

export const COLLECTION = 'payments';

const refundEntrySchema = {
  bsonType: 'object',
  required: ['amountCents', 'status', 'createdAt'],
  properties: {
    amountCents: { bsonType: 'int', minimum: 0 },
    reason: { bsonType: ['string', 'null'] },
    status: { enum: ['succeeded', 'pending', 'failed'] },
    yocoRefundId: { bsonType: ['string', 'null'] },
    refundedBy: { bsonType: 'objectId' },
    createdAt: { bsonType: 'date' },
  },
};

export const paymentsJsonSchema = {
  $jsonSchema: {
    bsonType: 'object',
    required: [
      'purpose',
      'appointmentId',
      'giftCardId',
      'subscriptionId',
      'userId',
      'guestEmail',
      'amountCents',
      'currency',
      'status',
      'refunds',
      'refundedAmountCents',
      'createdAt',
      'updatedAt',
    ],
    properties: {
      purpose: { enum: Object.values(PAYMENT_PURPOSE) },
      appointmentId: { bsonType: ['objectId', 'null'] },
      giftCardId: { bsonType: ['objectId', 'null'] },
      subscriptionId: { bsonType: ['objectId', 'null'] },
      userId: { bsonType: ['objectId', 'null'] },
      guestEmail: { bsonType: ['string', 'null'] },
      // Server-computed at write time — never accepted from the client (§5.1).
      amountCents: { bsonType: 'int', minimum: 0 },
      currency: { bsonType: 'string' },
      status: { enum: Object.values(PAYMENT_STATUS) },
      yocoCheckoutId: { bsonType: ['string', 'null'] },
      yocoPaymentId: { bsonType: ['string', 'null'] },
      redirectUrl: { bsonType: ['string', 'null'] },
      refunds: { bsonType: 'array', items: refundEntrySchema },
      refundedAmountCents: { bsonType: 'int', minimum: 0 },
      // Audit trail for what reduced the original full price down to amountCents (the
      // amount actually charged) — see paymentsService.initiateBookingDepositPayment.
      originalAmountCents: { bsonType: ['int', 'null'], minimum: 0 },
      pointsRedeemed: { bsonType: ['int', 'null'], minimum: 0 },
      redemptionValueCents: { bsonType: ['int', 'null'], minimum: 0 },
      discountCode: { bsonType: ['string', 'null'] },
      discountValueCents: { bsonType: ['int', 'null'], minimum: 0 },
      giftCardCode: { bsonType: ['string', 'null'] },
      giftCardValueCents: { bsonType: ['int', 'null'], minimum: 0 },
      createdAt: { bsonType: 'date' },
      updatedAt: { bsonType: 'date' },
    },
  },
};

export const paymentsIndexes = [
  { key: { yocoCheckoutId: 1 }, unique: true, sparse: true, name: 'uniq_yoco_checkout_id' },
  { key: { appointmentId: 1 }, name: 'idx_appointment' },
  { key: { giftCardId: 1 }, name: 'idx_gift_card' },
  { key: { userId: 1 }, name: 'idx_user' },
];

export function paymentsCollection() {
  return getDb().collection(COLLECTION);
}
