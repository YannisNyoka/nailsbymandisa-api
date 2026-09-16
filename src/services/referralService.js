import { ObjectId } from 'mongodb';
import { usersCollection } from '../models/users.js';
import { referralsCollection, REFERRAL_STATUS } from '../models/referrals.js';
import { generateCode } from '../utils/crypto.js';
import { REFERRAL_CODE_LENGTH } from '../config/constants.js';
import { createDiscountCode } from './discountsService.js';
import { awardPoints } from './loyaltyService.js';
import { getSettings } from './settingsService.js';
import { DISCOUNT_SOURCES, DISCOUNT_TYPES } from '../models/discountCodes.js';

export async function generateUniqueReferralCode() {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = generateCode(REFERRAL_CODE_LENGTH);
    // eslint-disable-next-line no-await-in-loop -- bounded retry loop, not a per-item scan
    if (!(await usersCollection().findOne({ referralCode: candidate }))) return candidate;
  }
  throw new Error('Could not generate a unique referral code after 5 attempts.');
}

// Called from authService.register() when a new signup supplies someone else's referral
// code. Creates the pending referral link and the friend's welcome discount in one place
// — via createDiscountCode(), the one shared discount-code constructor (§4.6) — so this
// can never drift from the real DISCOUNT_CODES shape.
export async function linkReferralOnRegistration({ newUserId, referralCodeUsed }) {
  const referrer = await usersCollection().findOne({ referralCode: referralCodeUsed });
  if (!referrer || String(referrer._id) === String(newUserId)) return null;

  const settings = await getSettings();
  const welcomeCode = await createDiscountCode({
    type: DISCOUNT_TYPES.PERCENTAGE,
    value: settings.referral.welcomeDiscountPercent,
    usageLimit: 1,
    source: DISCOUNT_SOURCES.REFERRAL,
    metadata: { referredUserId: String(newUserId) },
  });

  await referralsCollection().insertOne({
    referrerUserId: referrer._id,
    referredUserId: new ObjectId(newUserId),
    code: referralCodeUsed,
    status: REFERRAL_STATUS.PENDING,
    discountCodeId: welcomeCode._id,
    createdAt: new Date(),
    completedAt: null,
  });

  return welcomeCode;
}

// §4.6 — the referrer earns points when the referred friend completes their FIRST
// booking. Called from paymentsService.handlePaymentSucceeded(); the atomic
// pending→completed transition guard means a webhook replay can't double-award the
// referrer, same pattern as the booking-confirmation guarantee it sits alongside.
export async function completeReferralIfPending(referredUserId) {
  const referral = await referralsCollection().findOneAndUpdate(
    { referredUserId: new ObjectId(referredUserId), status: REFERRAL_STATUS.PENDING },
    { $set: { status: REFERRAL_STATUS.COMPLETED, completedAt: new Date() } }
  );
  if (!referral) return;

  const settings = await getSettings();
  await awardPoints({
    userId: referral.referrerUserId,
    points: settings.referral.referrerBonusPoints,
    source: 'referral_bonus',
    note: `Referral bonus for inviting a friend who completed their first booking`,
  });
}
