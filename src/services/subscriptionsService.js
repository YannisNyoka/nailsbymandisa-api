import { ObjectId } from 'mongodb';
import { subscriptionsCollection, SUBSCRIPTION_STATUS } from '../models/subscriptions.js';
import { getPlan } from './subscriptionPlansService.js';
import { badRequest, conflict } from '../utils/AppError.js';
import { sortByCreatedAtDesc } from '../utils/sorting.js';
import { paginate } from '../utils/pagination.js';

export async function getUserSubscription(userId) {
  return subscriptionsCollection().findOne({ userId: new ObjectId(userId) });
}

// Creates or reuses the caller's single subscription document, moving it into 'pending'
// (or keeping it 'active' if this is a renewal of an already-active plan, so the
// customer doesn't lose access while the renewal payment is in flight). The unique
// index on userId is what makes "one subscription doc per user" a real guarantee, not
// just convention — this function upserts into it rather than ever inserting a second row.
export async function upsertPendingSubscription({ userId, planId }) {
  const uid = new ObjectId(userId);
  const existing = await getUserSubscription(uid);

  if (existing && existing.status === SUBSCRIPTION_STATUS.ACTIVE && String(existing.planId) !== String(planId)) {
    throw badRequest('Cancel your current subscription before switching plans.');
  }

  const now = new Date();
  if (existing) {
    await subscriptionsCollection().updateOne(
      { _id: existing._id },
      {
        $set: {
          planId: new ObjectId(planId),
          status: existing.status === SUBSCRIPTION_STATUS.ACTIVE ? SUBSCRIPTION_STATUS.ACTIVE : SUBSCRIPTION_STATUS.PENDING,
          updatedAt: now,
        },
      }
    );
    return subscriptionsCollection().findOne({ _id: existing._id });
  }

  const doc = {
    userId: uid,
    planId: new ObjectId(planId),
    status: SUBSCRIPTION_STATUS.PENDING,
    creditsRemaining: 0,
    currentPeriodEnd: null,
    paymentId: null,
    createdAt: now,
    updatedAt: now,
    cancelledAt: null,
  };
  const { insertedId } = await subscriptionsCollection().insertOne(doc);
  return { ...doc, _id: insertedId };
}

// Called once a subscription payment succeeds — resets the credit balance to a full
// period's worth (unused credits don't roll over: "N credits per period", not an
// ever-growing balance) and starts a fresh period from now, whether this is a first
// subscribe or a renewal. Looks the plan up itself (rather than trusting a caller-passed
// plan object) so this stays correct even if upsertPendingSubscription() let the plan
// change between "subscribe" and "payment confirmed".
export async function activateSubscription({ subscriptionId, paymentId }) {
  const subscription = await subscriptionsCollection().findOne({ _id: new ObjectId(subscriptionId) });
  if (!subscription) return null;
  const plan = await getPlan(subscription.planId);

  const now = new Date();
  return subscriptionsCollection().findOneAndUpdate(
    { _id: new ObjectId(subscriptionId), status: { $in: [SUBSCRIPTION_STATUS.PENDING, SUBSCRIPTION_STATUS.ACTIVE] } },
    {
      $set: {
        status: SUBSCRIPTION_STATUS.ACTIVE,
        creditsRemaining: plan.creditsPerPeriod,
        currentPeriodEnd: new Date(now.getTime() + plan.periodDays * 86_400_000),
        paymentId: new ObjectId(paymentId),
        updatedAt: now,
      },
    }
  );
}

// §4.8/§6.1 — the credit-availability check and the decrement are the same atomic
// operation, guarded on status/expiry/balance all at once, mirroring loyalty points and
// gift card balances — a credit can never be spent twice or spent past expiry.
export async function useCredit({ userId }) {
  const result = await subscriptionsCollection().findOneAndUpdate(
    {
      userId: new ObjectId(userId),
      status: SUBSCRIPTION_STATUS.ACTIVE,
      creditsRemaining: { $gte: 1 },
      currentPeriodEnd: { $gte: new Date() },
    },
    { $inc: { creditsRemaining: -1 }, $set: { updatedAt: new Date() } }
  );
  if (!result) throw conflict('No subscription credit is available.');
  return true;
}

export async function cancelSubscription(userId) {
  const result = await subscriptionsCollection().updateOne(
    { userId: new ObjectId(userId), status: SUBSCRIPTION_STATUS.ACTIVE },
    { $set: { status: SUBSCRIPTION_STATUS.CANCELLED, cancelledAt: new Date(), updatedAt: new Date() } }
  );
  if (result.matchedCount === 0) throw badRequest('You do not have an active subscription to cancel.');
}

export async function listActiveSubscribersForPlan(planId) {
  return (
    await subscriptionsCollection().find({ planId: new ObjectId(planId), status: SUBSCRIPTION_STATUS.ACTIVE })
  ).toArray();
}

export async function listAllSubscriptions({ page = 1, pageSize = 20 } = {}) {
  const all = await (await subscriptionsCollection().find({})).toArray();
  const sorted = sortByCreatedAtDesc(all);
  const { items, total } = paginate(sorted, { page, pageSize });
  return { subscriptions: items, total, page, pageSize };
}
