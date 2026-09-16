import { ObjectId } from 'mongodb';
import { subscriptionPlansCollection } from '../models/subscriptionPlans.js';
import { subscriptionsCollection, SUBSCRIPTION_STATUS } from '../models/subscriptions.js';
import { conflict, notFound } from '../utils/AppError.js';

export async function listPlans({ includeInactive = false } = {}) {
  const filter = includeInactive ? {} : { isActive: true };
  return (await subscriptionPlansCollection().find(filter)).toArray();
}

export async function getPlan(id) {
  const plan = await subscriptionPlansCollection().findOne({ _id: new ObjectId(id) });
  if (!plan) throw notFound('Subscription plan');
  return plan;
}

export async function createPlan({ name, description = null, priceCents, creditsPerPeriod, periodDays = 30 }) {
  const now = new Date();
  const doc = { name, description, priceCents, creditsPerPeriod, periodDays, isActive: true, createdAt: now, updatedAt: now };
  const { insertedId } = await subscriptionPlansCollection().insertOne(doc);
  return { ...doc, _id: insertedId };
}

export async function updatePlan(id, data) {
  await getPlan(id);
  await subscriptionPlansCollection().updateOne({ _id: new ObjectId(id) }, { $set: { ...data, updatedAt: new Date() } });
  return getPlan(id);
}

// §4.8 — plan deletion is blocked while active subscribers exist, rather than silently
// orphaning them (their subscription would keep referencing a planId that no longer
// resolves). An admin who wants to sunset a plan can deactivate it first (blocks new
// subscribers) and revisit deletion once existing ones have cancelled or lapsed.
export async function deletePlan(id) {
  await getPlan(id);
  const activeSubscribers = await subscriptionsCollection().findOne({
    planId: new ObjectId(id),
    status: { $in: [SUBSCRIPTION_STATUS.PENDING, SUBSCRIPTION_STATUS.ACTIVE] },
  });
  if (activeSubscribers) {
    throw conflict('This plan has active subscribers and cannot be deleted. Deactivate it instead to stop new signups.');
  }
  await subscriptionPlansCollection().deleteOne({ _id: new ObjectId(id) });
}
