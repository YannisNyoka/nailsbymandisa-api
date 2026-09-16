import { ObjectId } from 'mongodb';
import { giftCardsCollection, GIFT_CARD_STATUS } from '../models/giftCards.js';
import { generateCode } from '../utils/crypto.js';
import { GIFT_CARD_CODE_LENGTH } from '../config/constants.js';
import { badRequest, conflict, forbidden, notFound } from '../utils/AppError.js';
import { sortByCreatedAtDesc } from '../utils/sorting.js';
import { paginate } from '../utils/pagination.js';

async function generateUniqueGiftCardCode() {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = generateCode(GIFT_CARD_CODE_LENGTH);
    // eslint-disable-next-line no-await-in-loop -- bounded retry loop, not a per-item scan
    if (!(await giftCardsCollection().findOne({ code: candidate }))) return candidate;
  }
  throw new Error('Could not generate a unique gift card code after 5 attempts.');
}

// §4.7 — created in a pending state with a zero balance; the balance only becomes
// spendable once activateGiftCard() runs off a confirmed payment (never before —
// nothing here trusts a client-submitted "it's paid" claim).
export async function createPendingGiftCard({ initialAmountCents, purchasedByUserId, purchaserEmail, recipientEmail }) {
  const code = await generateUniqueGiftCardCode();
  const now = new Date();
  const doc = {
    code,
    initialAmountCents,
    balanceCents: 0,
    status: GIFT_CARD_STATUS.PENDING,
    purchasedByUserId: purchasedByUserId ? new ObjectId(purchasedByUserId) : null,
    purchaserEmail,
    recipientEmail: recipientEmail ?? null,
    paymentId: null,
    redemptions: [],
    createdAt: now,
    updatedAt: now,
  };
  const { insertedId } = await giftCardsCollection().insertOne(doc);
  return { ...doc, _id: insertedId };
}

// Called from paymentsService.handlePaymentSucceeded, itself guarded by the payment's
// own pending→paid atomic transition — so this only ever runs once per gift card too.
export async function activateGiftCard({ giftCardId, amountCents, paymentId }) {
  return giftCardsCollection().findOneAndUpdate(
    { _id: new ObjectId(giftCardId), status: GIFT_CARD_STATUS.PENDING },
    {
      $set: {
        status: GIFT_CARD_STATUS.ACTIVE,
        balanceCents: amountCents,
        paymentId: new ObjectId(paymentId),
        updatedAt: new Date(),
      },
    }
  );
}

// §4.7/§6.1 — redeems up to `maxAmountCents` of whatever balance remains, as ONE atomic
// operation guarded on the balance being at least what we're about to take. Two
// concurrent bookings spending the same card can't together overdraw it: whichever
// commits first shrinks the balance, and the second's guard then reflects the new total.
export async function redeemUpTo({ code, maxAmountCents, appointmentId = null }) {
  if (maxAmountCents <= 0) return { valueCents: 0 };
  const card = await giftCardsCollection().findOne({ code: code.toUpperCase() });
  if (!card) throw badRequest('This gift card code does not exist.');
  if (card.status !== GIFT_CARD_STATUS.ACTIVE) throw badRequest('This gift card is not active.');

  const amountToRedeem = Math.min(card.balanceCents, maxAmountCents);
  if (amountToRedeem <= 0) return { valueCents: 0 };

  const result = await giftCardsCollection().findOneAndUpdate(
    { code: card.code, status: GIFT_CARD_STATUS.ACTIVE, balanceCents: { $gte: amountToRedeem } },
    {
      $inc: { balanceCents: -amountToRedeem },
      $push: { redemptions: { amountCents: amountToRedeem, appointmentId: appointmentId ? new ObjectId(appointmentId) : null, createdAt: new Date() } },
      $set: { updatedAt: new Date() },
    }
  );
  if (!result) throw conflict('This gift card balance just changed — please try again.');
  return { valueCents: amountToRedeem };
}

export async function getGiftCardByCode(code) {
  const card = await giftCardsCollection().findOne({ code: code.toUpperCase() });
  if (!card) throw notFound('Gift card');
  return card;
}

export async function listGiftCardsForUser(userId) {
  return (await giftCardsCollection().find({ purchasedByUserId: new ObjectId(userId) })).toArray();
}

export async function listAllGiftCards({ page = 1, pageSize = 20 } = {}) {
  const all = await (await giftCardsCollection().find({})).toArray();
  const sorted = sortByCreatedAtDesc(all);
  const { items, total } = paginate(sorted, { page, pageSize });
  return { giftCards: items, total, page, pageSize };
}

export function assertGiftCardAccess(card, actor) {
  if (actor.role === 'admin') return;
  if (!card.purchasedByUserId || String(card.purchasedByUserId) !== String(actor._id)) {
    throw forbidden('You do not have access to this gift card.');
  }
}
