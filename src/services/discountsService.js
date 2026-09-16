import { ObjectId } from 'mongodb';
import { discountCodesCollection, DISCOUNT_TYPES, DISCOUNT_SOURCES } from '../models/discountCodes.js';
import { generateCode } from '../utils/crypto.js';
import { DISCOUNT_CODE_LENGTH } from '../config/constants.js';
import { badRequest, conflict, notFound } from '../utils/AppError.js';
import { sortByCreatedAtDesc } from '../utils/sorting.js';
import { paginate } from '../utils/pagination.js';

// The one place a discount-code document is ever constructed (§4.6/§4.9) — the referral
// flow calls this rather than building a raw document inline, so a referral reward can
// never drift out of sync with the real DISCOUNT_CODES shape.
export async function createDiscountCode({
  code,
  type,
  value,
  minBookingAmountCents = null,
  usageLimit = null,
  expiresAt = null,
  source = DISCOUNT_SOURCES.ADMIN,
  metadata = null,
}) {
  if (!Object.values(DISCOUNT_TYPES).includes(type)) throw badRequest('Invalid discount type.');
  if (type === DISCOUNT_TYPES.PERCENTAGE && (value < 1 || value > 100)) {
    throw badRequest('Percentage discount value must be between 1 and 100.');
  }
  if (type === DISCOUNT_TYPES.FIXED && value < 1) throw badRequest('Fixed discount value must be at least 1 cent.');

  let finalCode = code ? code.toUpperCase() : null;
  if (!finalCode) {
    // Generated codes are checked for uniqueness before insert; the unique index is
    // still the real guarantee against a race, this just avoids a pointless collision
    // in the overwhelmingly common case.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = generateCode(DISCOUNT_CODE_LENGTH);
      // eslint-disable-next-line no-await-in-loop -- bounded retry loop, not a per-item scan
      if (!(await discountCodesCollection().findOne({ code: candidate }))) {
        finalCode = candidate;
        break;
      }
    }
    if (!finalCode) throw new Error('Could not generate a unique discount code after 5 attempts.');
  }

  const now = new Date();
  const doc = {
    code: finalCode,
    type,
    value,
    minBookingAmountCents,
    usesRemaining: usageLimit,
    usageCount: 0,
    expiresAt,
    isActive: true,
    source,
    metadata,
    createdAt: now,
    updatedAt: now,
  };
  const { insertedId } = await discountCodesCollection().insertOne(doc);
  return { ...doc, _id: insertedId };
}

export async function getDiscountCodeByCode(code) {
  const doc = await discountCodesCollection().findOne({ code: code.toUpperCase() });
  if (!doc) throw notFound('Discount code');
  return doc;
}

export function computeDiscountValueCents(discount, amountCents) {
  if (discount.type === DISCOUNT_TYPES.PERCENTAGE) {
    return Math.round((amountCents * discount.value) / 100);
  }
  return Math.min(discount.value, amountCents);
}

// Read-only check (no side effects) — used to preview a discount before committing to
// redeeming it. The actual atomic increment happens in redeemDiscountCode().
export async function validateDiscountCode({ code, amountCents }) {
  const discount = await discountCodesCollection().findOne({ code: code.toUpperCase() });
  if (!discount) throw badRequest('This discount code does not exist.');
  if (!discount.isActive) throw badRequest('This discount code is no longer active.');
  if (discount.expiresAt && discount.expiresAt < new Date()) throw badRequest('This discount code has expired.');
  if (discount.usesRemaining !== null && discount.usesRemaining <= 0) {
    throw badRequest('This discount code has reached its usage limit.');
  }
  if (discount.minBookingAmountCents && amountCents < discount.minBookingAmountCents) {
    throw badRequest(`This code requires a minimum booking amount of ${discount.minBookingAmountCents} cents.`);
  }
  return { discount, discountValueCents: computeDiscountValueCents(discount, amountCents) };
}

// §4.9/§6.1 — atomic increment-and-check: the usage-limit guard and the increment are
// the same database operation, so two concurrent redemptions of the last use can't both
// succeed. Unlimited codes (usesRemaining: null) skip the guard since there's nothing to
// enforce, but still record usageCount for reporting.
export async function redeemDiscountCode(code) {
  const upperCode = code.toUpperCase();
  const unlimited = await discountCodesCollection().findOneAndUpdate(
    { code: upperCode, isActive: true, usesRemaining: null },
    { $inc: { usageCount: 1 }, $set: { updatedAt: new Date() } }
  );
  if (unlimited) return discountCodesCollection().findOne({ code: upperCode });

  const limited = await discountCodesCollection().findOneAndUpdate(
    { code: upperCode, isActive: true, usesRemaining: { $gt: 0 } },
    { $inc: { usesRemaining: -1, usageCount: 1 }, $set: { updatedAt: new Date() } }
  );
  if (!limited) throw conflict('This discount code is no longer available.');
  return discountCodesCollection().findOne({ code: upperCode });
}

export async function listDiscountCodes({ page = 1, pageSize = 20 } = {}) {
  const all = await (await discountCodesCollection().find({})).toArray();
  const sorted = sortByCreatedAtDesc(all);
  const { items, total } = paginate(sorted, { page, pageSize });
  return { discountCodes: items, total, page, pageSize };
}

export async function setDiscountCodeActive(id, isActive) {
  const result = await discountCodesCollection().updateOne(
    { _id: new ObjectId(id) },
    { $set: { isActive, updatedAt: new Date() } }
  );
  if (result.matchedCount === 0) throw notFound('Discount code');
}
