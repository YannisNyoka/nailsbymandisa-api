import { setTestDb } from '../../src/config/db.js';
import { createFakeDb } from '../helpers/fakeDb.js';
import * as authService from '../../src/services/authService.js';
import * as referralService from '../../src/services/referralService.js';
import { getLedger } from '../../src/services/loyaltyService.js';
import { referralsCollection } from '../../src/models/referrals.js';

beforeEach(() => {
  setTestDb(createFakeDb());
});

describe('registration with a referral code', () => {
  it('gives the new user their own referral code and creates a pending referral + welcome discount', async () => {
    const { user: referrer } = await authService.register({
      email: 'referrer@example.com',
      password: 'supersecret123',
      firstName: 'Ref',
      lastName: 'Errer',
    });
    expect(referrer.referralCode).toEqual(expect.any(String));

    const { user: friend, welcomeDiscountCode } = await authService.register({
      email: 'friend@example.com',
      password: 'supersecret123',
      firstName: 'Friend',
      lastName: 'Person',
      referralCode: referrer.referralCode,
    });

    expect(friend.referredBy).toBe(referrer.referralCode);
    expect(welcomeDiscountCode).toEqual(expect.any(String));

    const referral = await referralsCollection().findOne({ referredUserId: friend._id });
    expect(referral.status).toBe('pending');
    expect(String(referral.referrerUserId)).toBe(String(referrer._id));
  });

  it('ignores an unknown referral code without failing registration', async () => {
    const { user, welcomeDiscountCode } = await authService.register({
      email: 'solo@example.com',
      password: 'supersecret123',
      firstName: 'Solo',
      lastName: 'Person',
      referralCode: 'NOTAREALCODE',
    });
    expect(user.referredBy).toBeNull();
    expect(welcomeDiscountCode).toBeNull();
  });

  it('ignores a self-referral', async () => {
    const { user } = await authService.register({
      email: 'self@example.com',
      password: 'supersecret123',
      firstName: 'Self',
      lastName: 'Referrer',
    });
    const created = await referralService.linkReferralOnRegistration({
      newUserId: user._id,
      referralCodeUsed: user.referralCode,
    });
    expect(created).toBeNull();
    const referral = await referralsCollection().findOne({ referredUserId: user._id });
    expect(referral).toBeNull();
  });
});

describe('referralService.completeReferralIfPending', () => {
  it('awards the referrer points exactly once, even if called twice (idempotent)', async () => {
    const { user: referrer } = await authService.register({
      email: 'referrer2@example.com',
      password: 'supersecret123',
      firstName: 'Ref',
      lastName: 'Errer',
    });
    const { user: friend } = await authService.register({
      email: 'friend2@example.com',
      password: 'supersecret123',
      firstName: 'Friend',
      lastName: 'Person',
      referralCode: referrer.referralCode,
    });

    await referralService.completeReferralIfPending(friend._id);
    const ledgerAfterFirst = await getLedger(referrer._id);
    expect(ledgerAfterFirst.pointsBalance).toBeGreaterThan(0);

    await referralService.completeReferralIfPending(friend._id);
    const ledgerAfterSecond = await getLedger(referrer._id);
    expect(ledgerAfterSecond.pointsBalance).toBe(ledgerAfterFirst.pointsBalance);
  });

  it('does nothing when there is no pending referral for the user', async () => {
    const { user } = await authService.register({
      email: 'nobody@example.com',
      password: 'supersecret123',
      firstName: 'No',
      lastName: 'Referral',
    });
    await expect(referralService.completeReferralIfPending(user._id)).resolves.toBeUndefined();
  });
});
