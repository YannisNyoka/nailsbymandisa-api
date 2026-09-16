import { setTestDb } from '../../src/config/db.js';
import { createFakeDb } from '../helpers/fakeDb.js';
import * as discountsService from '../../src/services/discountsService.js';
import { discountCodesCollection, discountCodesIndexes } from '../../src/models/discountCodes.js';

beforeEach(async () => {
  setTestDb(createFakeDb());
  await discountCodesCollection().createIndexes(discountCodesIndexes);
});

describe('discountsService.createDiscountCode', () => {
  it('generates a unique code when none is supplied', async () => {
    const discount = await discountsService.createDiscountCode({ type: 'percentage', value: 10, usageLimit: 1 });
    expect(discount.code).toEqual(expect.any(String));
    expect(discount.code.length).toBeGreaterThan(0);
    expect(discount.usesRemaining).toBe(1);
    expect(discount.usageCount).toBe(0);
  });

  it('uppercases and uses a supplied code', async () => {
    const discount = await discountsService.createDiscountCode({ code: 'welcome10', type: 'percentage', value: 10 });
    expect(discount.code).toBe('WELCOME10');
  });

  it('rejects an out-of-range percentage value', async () => {
    await expect(discountsService.createDiscountCode({ type: 'percentage', value: 150 })).rejects.toMatchObject({
      statusCode: 400,
    });
  });
});

describe('discountsService.validateDiscountCode', () => {
  it('computes a percentage discount value', async () => {
    await discountsService.createDiscountCode({ code: 'TEN', type: 'percentage', value: 10 });
    const { discountValueCents } = await discountsService.validateDiscountCode({ code: 'ten', amountCents: 10000 });
    expect(discountValueCents).toBe(1000);
  });

  it('caps a fixed discount at the order amount', async () => {
    await discountsService.createDiscountCode({ code: 'BIGFIXED', type: 'fixed', value: 50000 });
    const { discountValueCents } = await discountsService.validateDiscountCode({ code: 'BIGFIXED', amountCents: 10000 });
    expect(discountValueCents).toBe(10000);
  });

  it('rejects a code below its minimum booking amount', async () => {
    await discountsService.createDiscountCode({ code: 'MIN200', type: 'fixed', value: 1000, minBookingAmountCents: 20000 });
    await expect(discountsService.validateDiscountCode({ code: 'MIN200', amountCents: 10000 })).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it('rejects an inactive code', async () => {
    const discount = await discountsService.createDiscountCode({ code: 'OFF', type: 'fixed', value: 1000 });
    await discountsService.setDiscountCodeActive(discount._id, false);
    await expect(discountsService.validateDiscountCode({ code: 'OFF', amountCents: 10000 })).rejects.toMatchObject({
      statusCode: 400,
    });
  });
});

describe('discountsService.redeemDiscountCode — atomic usage-limit enforcement', () => {
  it('lets an unlimited code be used repeatedly', async () => {
    await discountsService.createDiscountCode({ code: 'FOREVER', type: 'fixed', value: 500 });
    await discountsService.redeemDiscountCode('forever');
    await discountsService.redeemDiscountCode('forever');
    const discount = await discountsService.getDiscountCodeByCode('FOREVER');
    expect(discount.usageCount).toBe(2);
    expect(discount.usesRemaining).toBeNull();
  });

  it('rejects redemption once a limited code is exhausted', async () => {
    await discountsService.createDiscountCode({ code: 'ONCE', type: 'fixed', value: 500, usageLimit: 1 });
    await discountsService.redeemDiscountCode('ONCE');
    await expect(discountsService.redeemDiscountCode('ONCE')).rejects.toMatchObject({ statusCode: 409 });
  });

  it('lets only one of two concurrent redemptions win the last use', async () => {
    await discountsService.createDiscountCode({ code: 'LASTONE', type: 'fixed', value: 500, usageLimit: 1 });
    const results = await Promise.allSettled([
      discountsService.redeemDiscountCode('LASTONE'),
      discountsService.redeemDiscountCode('LASTONE'),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const discount = await discountsService.getDiscountCodeByCode('LASTONE');
    expect(discount.usesRemaining).toBe(0);
    expect(discount.usageCount).toBe(1);
  });
});
