import { ObjectId } from 'mongodb';
import { setTestDb } from '../../src/config/db.js';
import { createFakeDb } from '../helpers/fakeDb.js';
import { subscriptionsCollection, subscriptionsIndexes } from '../../src/models/subscriptions.js';
import * as subscriptionPlansService from '../../src/services/subscriptionPlansService.js';
import * as subscriptionsService from '../../src/services/subscriptionsService.js';

beforeEach(async () => {
  setTestDb(createFakeDb());
  await subscriptionsCollection().createIndexes(subscriptionsIndexes);
});

async function makePlan(overrides = {}) {
  return subscriptionPlansService.createPlan({
    name: 'Monthly Glow',
    priceCents: 50000,
    creditsPerPeriod: 4,
    periodDays: 30,
    ...overrides,
  });
}

describe('subscriptionPlansService.deletePlan', () => {
  it('blocks deletion while an active subscriber exists', async () => {
    const plan = await makePlan();
    const userId = new ObjectId();
    const sub = await subscriptionsService.upsertPendingSubscription({ userId, planId: plan._id });
    await subscriptionsService.activateSubscription({ subscriptionId: sub._id, paymentId: new ObjectId() });

    await expect(subscriptionPlansService.deletePlan(plan._id)).rejects.toMatchObject({ statusCode: 409 });
  });

  it('allows deletion once there are no active/pending subscribers', async () => {
    const plan = await makePlan();
    await expect(subscriptionPlansService.deletePlan(plan._id)).resolves.toBeUndefined();
  });
});

describe('subscriptionsService.upsertPendingSubscription / activateSubscription', () => {
  it('creates one subscription document per user and reuses it on resubscribe', async () => {
    const plan = await makePlan();
    const userId = new ObjectId();

    const first = await subscriptionsService.upsertPendingSubscription({ userId, planId: plan._id });
    const second = await subscriptionsService.upsertPendingSubscription({ userId, planId: plan._id });
    expect(String(second._id)).toBe(String(first._id));
  });

  it('resets credits to a full period on activation and does not roll over', async () => {
    const plan = await makePlan({ creditsPerPeriod: 3 });
    const userId = new ObjectId();
    const sub = await subscriptionsService.upsertPendingSubscription({ userId, planId: plan._id });
    await subscriptionsService.activateSubscription({ subscriptionId: sub._id, paymentId: new ObjectId() });

    let current = await subscriptionsService.getUserSubscription(userId);
    expect(current.status).toBe('active');
    expect(current.creditsRemaining).toBe(3);

    await subscriptionsService.useCredit({ userId });
    current = await subscriptionsService.getUserSubscription(userId);
    expect(current.creditsRemaining).toBe(2);

    // Renewing (activating again) resets to a fresh 3, not 2+3.
    await subscriptionsService.activateSubscription({ subscriptionId: sub._id, paymentId: new ObjectId() });
    current = await subscriptionsService.getUserSubscription(userId);
    expect(current.creditsRemaining).toBe(3);
  });

  it('rejects subscribing to a different plan while one is already active', async () => {
    const planA = await makePlan({ name: 'A' });
    const planB = await makePlan({ name: 'B' });
    const userId = new ObjectId();
    const sub = await subscriptionsService.upsertPendingSubscription({ userId, planId: planA._id });
    await subscriptionsService.activateSubscription({ subscriptionId: sub._id, paymentId: new ObjectId() });

    await expect(subscriptionsService.upsertPendingSubscription({ userId, planId: planB._id })).rejects.toMatchObject({
      statusCode: 400,
    });
  });
});

describe('subscriptionsService.useCredit — atomic floor', () => {
  async function activeSubscription(creditsPerPeriod = 2) {
    const plan = await makePlan({ creditsPerPeriod });
    const userId = new ObjectId();
    const sub = await subscriptionsService.upsertPendingSubscription({ userId, planId: plan._id });
    await subscriptionsService.activateSubscription({ subscriptionId: sub._id, paymentId: new ObjectId() });
    return userId;
  }

  it('rejects use when no credits remain', async () => {
    const userId = await activeSubscription(1);
    await subscriptionsService.useCredit({ userId });
    await expect(subscriptionsService.useCredit({ userId })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('rejects use for a cancelled subscription even with credits left', async () => {
    const userId = await activeSubscription(5);
    await subscriptionsService.cancelSubscription(userId);
    await expect(subscriptionsService.useCredit({ userId })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('lets only one of two concurrent uses win the last credit', async () => {
    const userId = await activeSubscription(1);
    const results = await Promise.allSettled([subscriptionsService.useCredit({ userId }), subscriptionsService.useCredit({ userId })]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const sub = await subscriptionsService.getUserSubscription(userId);
    expect(sub.creditsRemaining).toBe(0);
  });
});
