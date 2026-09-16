import { ObjectId } from 'mongodb';
import { setTestDb } from '../../src/config/db.js';
import { createFakeDb } from '../helpers/fakeDb.js';
import * as loyaltyService from '../../src/services/loyaltyService.js';
import { getSettings } from '../../src/services/settingsService.js';

beforeEach(() => {
  setTestDb(createFakeDb());
});

describe('loyaltyService.awardPoints', () => {
  it('creates an account on first award and builds a ledger entry', async () => {
    const userId = new ObjectId();
    const balance = await loyaltyService.awardPoints({ userId, points: 150, source: 'booking_deposit_payment' });
    expect(balance).toBe(150);

    const ledger = await loyaltyService.getLedger(userId);
    expect(ledger.pointsBalance).toBe(150);
    expect(ledger.lifetimePointsEarned).toBe(150);
    expect(ledger.transactions).toHaveLength(1);
    expect(ledger.transactions[0]).toMatchObject({ type: 'earn', points: 150, balanceAfter: 150 });
  });

  it('accumulates across multiple awards', async () => {
    const userId = new ObjectId();
    await loyaltyService.awardPoints({ userId, points: 100, source: 'a' });
    await loyaltyService.awardPoints({ userId, points: 50, source: 'b' });
    const ledger = await loyaltyService.getLedger(userId);
    expect(ledger.pointsBalance).toBe(150);
    expect(ledger.lifetimePointsEarned).toBe(150);
  });
});

describe('loyaltyService.redeemPoints', () => {
  it('rejects redemption below the configured minimum', async () => {
    const userId = new ObjectId();
    await loyaltyService.awardPoints({ userId, points: 500, source: 'a' });
    await expect(loyaltyService.redeemPoints({ userId, points: 50 })).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects redemption beyond the available balance', async () => {
    const userId = new ObjectId();
    await loyaltyService.awardPoints({ userId, points: 100, source: 'a' });
    await expect(loyaltyService.redeemPoints({ userId, points: 200 })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('atomically decrements the balance and records the redemption value', async () => {
    const userId = new ObjectId();
    await loyaltyService.awardPoints({ userId, points: 500, source: 'a' });
    const settings = await getSettings();

    const { valueCents, balanceAfter } = await loyaltyService.redeemPoints({ userId, points: 200 });
    expect(valueCents).toBe(200 * settings.loyalty.redemptionCentsPerPoint);
    expect(balanceAfter).toBe(300);

    const ledger = await loyaltyService.getLedger(userId);
    expect(ledger.pointsBalance).toBe(300);
    // Lifetime earned never decreases on redemption — tier is based on this, not balance.
    expect(ledger.lifetimePointsEarned).toBe(500);
  });

  it('lets only one of two concurrent redemptions succeed once the balance is exhausted', async () => {
    const userId = new ObjectId();
    await loyaltyService.awardPoints({ userId, points: 300, source: 'a' });

    const results = await Promise.allSettled([
      loyaltyService.redeemPoints({ userId, points: 300 }),
      loyaltyService.redeemPoints({ userId, points: 300 }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const ledger = await loyaltyService.getLedger(userId);
    expect(ledger.pointsBalance).toBe(0);
  });
});

describe('loyaltyService.adjustPointsDown', () => {
  it('lets an admin deduct points below the customer minimum-redemption threshold', async () => {
    const userId = new ObjectId();
    await loyaltyService.awardPoints({ userId, points: 50, source: 'a' });
    await loyaltyService.adjustPointsDown({ userId, points: 20, note: 'Correcting a mistake' });
    const ledger = await loyaltyService.getLedger(userId);
    expect(ledger.pointsBalance).toBe(30);
    expect(ledger.transactions[0].type).toBe('adjust');
  });
});

describe('loyaltyService.previewRedemption', () => {
  it('caps redemption value at maxRedemptionPercent of the order amount', async () => {
    const settings = await getSettings();
    // Deposit of R150 (15000c); 50% cap = 7500c => at 10c/point, max 750 points.
    const preview = await loyaltyService.previewRedemption({ pointsRequested: 2000, amountCents: 15000, settings });
    expect(preview.points).toBeLessThanOrEqual(750);
    expect(preview.valueCents).toBeLessThanOrEqual(7500);
  });

  it('returns zero when the requested points fall under the minimum after capping', async () => {
    const settings = await getSettings();
    const preview = await loyaltyService.previewRedemption({ pointsRequested: 1, amountCents: 15000, settings });
    expect(preview.points).toBe(0);
    expect(preview.valueCents).toBe(0);
  });
});

describe('loyaltyService.getTier', () => {
  it('picks the highest tier the lifetime points qualify for', async () => {
    const settings = await getSettings();
    expect(loyaltyService.getTier(0, settings.loyalty.tiers).name).toBe('Bronze');
    expect(loyaltyService.getTier(600, settings.loyalty.tiers).name).toBe('Silver');
    expect(loyaltyService.getTier(10000, settings.loyalty.tiers).name).toBe('Platinum');
  });
});
