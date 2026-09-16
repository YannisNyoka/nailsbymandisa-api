import { ObjectId } from 'mongodb';
import { loyaltyAccountsCollection } from '../models/loyaltyAccounts.js';
import { loyaltyTransactionsCollection, LOYALTY_TRANSACTION_TYPES } from '../models/loyaltyTransactions.js';
import { getSettings } from './settingsService.js';
import { badRequest, conflict } from '../utils/AppError.js';
import { sortByCreatedAtDesc } from '../utils/sorting.js';

export async function getOrCreateAccount(userId) {
  const uid = new ObjectId(userId);
  const existing = await loyaltyAccountsCollection().findOne({ userId: uid });
  if (existing) return existing;

  const now = new Date();
  const doc = { userId: uid, pointsBalance: 0, lifetimePointsEarned: 0, createdAt: now, updatedAt: now };
  try {
    const { insertedId } = await loyaltyAccountsCollection().insertOne(doc);
    return { ...doc, _id: insertedId };
  } catch (err) {
    // Lost the race to create the account (unique index on userId) — someone else's
    // concurrent request created it first; just read what they made.
    if (err.code === 11000) return loyaltyAccountsCollection().findOne({ userId: uid });
    throw err;
  }
}

export function getTier(lifetimePointsEarned, tiers) {
  const sorted = [...tiers].sort((a, b) => a.minLifetimePoints - b.minLifetimePoints);
  return sorted.filter((t) => lifetimePointsEarned >= t.minLifetimePoints).pop() ?? sorted[0];
}

// §4.5 — earning is a plain atomic increment; no balance-floor concern on the earn side.
export async function awardPoints({ userId, points, source, relatedPaymentId = null, relatedAppointmentId = null, note = null }) {
  if (points <= 0) return null;
  const uid = new ObjectId(userId);
  await getOrCreateAccount(uid);

  const account = await loyaltyAccountsCollection().findOneAndUpdate(
    { userId: uid },
    { $inc: { pointsBalance: points, lifetimePointsEarned: points }, $set: { updatedAt: new Date() } }
  );
  const balanceAfter = (account?.pointsBalance ?? 0) + points;

  await loyaltyTransactionsCollection().insertOne({
    userId: uid,
    type: LOYALTY_TRANSACTION_TYPES.EARN,
    points,
    balanceAfter,
    source,
    relatedPaymentId: relatedPaymentId ? new ObjectId(relatedPaymentId) : null,
    relatedAppointmentId: relatedAppointmentId ? new ObjectId(relatedAppointmentId) : null,
    note,
    createdAt: new Date(),
  });
  return balanceAfter;
}

// §6.1 — the balance-sufficiency check and the decrement are the SAME atomic operation
// (filter guards on pointsBalance >= points), so a balance can never go negative even
// under concurrent spends. Shared by both redeemPoints() (customer checkout, which adds
// the minRedemptionPoints business rule on top) and admin corrections (which don't).
async function decrementBalance({ userId, points, type, source, relatedAppointmentId, note }) {
  const uid = new ObjectId(userId);
  const result = await loyaltyAccountsCollection().findOneAndUpdate(
    { userId: uid, pointsBalance: { $gte: points } },
    { $inc: { pointsBalance: -points }, $set: { updatedAt: new Date() } }
  );
  if (!result) throw conflict('Insufficient points balance.');

  const balanceAfter = result.pointsBalance - points;
  await loyaltyTransactionsCollection().insertOne({
    userId: uid,
    type,
    points: -points,
    balanceAfter,
    source,
    relatedPaymentId: null,
    relatedAppointmentId: relatedAppointmentId ? new ObjectId(relatedAppointmentId) : null,
    note,
    createdAt: new Date(),
  });
  return balanceAfter;
}

// §4.5 — customer-initiated redemption at checkout; enforces the configured minimum
// redemption threshold. Returns the redeemed value in cents so the caller (checkout)
// can apply it — never accepts a caller-supplied value for what points are worth.
export async function redeemPoints({ userId, points, relatedAppointmentId = null, note = null }) {
  const settings = await getSettings();
  if (points < settings.loyalty.minRedemptionPoints) {
    throw badRequest(`A minimum of ${settings.loyalty.minRedemptionPoints} points is required to redeem.`);
  }
  const balanceAfter = await decrementBalance({
    userId,
    points,
    type: LOYALTY_TRANSACTION_TYPES.REDEEM,
    source: 'booking_checkout',
    relatedAppointmentId,
    note,
  });
  return { valueCents: points * settings.loyalty.redemptionCentsPerPoint, balanceAfter };
}

// Admin manual deduction (e.g. correcting an error) — same atomic floor guard as
// redeemPoints(), but skips the customer-facing minimum-redemption business rule, which
// doesn't apply to an admin fixing a mistake.
export async function adjustPointsDown({ userId, points, note = null }) {
  return decrementBalance({ userId, points, type: LOYALTY_TRANSACTION_TYPES.ADJUST, source: 'admin_adjustment', note });
}

// Given how much of `amountCents` the caller wants to cover with points, clamps to the
// configured max-redemption-percent-of-order cap (§4.5) and returns how many points that
// actually costs — the caller still goes through redeemPoints() for the atomic spend.
export async function previewRedemption({ pointsRequested, amountCents, settings }) {
  if (!pointsRequested) return { points: 0, valueCents: 0 };
  const maxValueCents = Math.floor((amountCents * settings.loyalty.maxRedemptionPercent) / 100);
  const maxPoints = Math.floor(maxValueCents / settings.loyalty.redemptionCentsPerPoint);
  const points = Math.min(pointsRequested, maxPoints);
  if (points < settings.loyalty.minRedemptionPoints) return { points: 0, valueCents: 0 };
  return { points, valueCents: points * settings.loyalty.redemptionCentsPerPoint };
}

export async function getLedger(userId, { page = 1, pageSize = 20 } = {}) {
  const uid = new ObjectId(userId);
  const [account, all] = await Promise.all([
    getOrCreateAccount(uid),
    (await loyaltyTransactionsCollection().find({ userId: uid })).toArray(),
  ]);
  const settings = await getSettings();
  const sorted = sortByCreatedAtDesc(all);
  const start = (page - 1) * pageSize;

  return {
    pointsBalance: account.pointsBalance,
    lifetimePointsEarned: account.lifetimePointsEarned,
    tier: getTier(account.lifetimePointsEarned, settings.loyalty.tiers),
    tiers: settings.loyalty.tiers,
    transactions: sorted.slice(start, start + pageSize),
    total: all.length,
    page,
    pageSize,
  };
}
