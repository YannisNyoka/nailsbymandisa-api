import { ObjectId } from 'mongodb';
import { setTestDb } from '../../src/config/db.js';
import { createFakeDb } from '../helpers/fakeDb.js';
import { giftCardsCollection, giftCardsIndexes } from '../../src/models/giftCards.js';
import * as giftCardsService from '../../src/services/giftCardsService.js';

beforeEach(async () => {
  setTestDb(createFakeDb());
  await giftCardsCollection().createIndexes(giftCardsIndexes);
});

async function activeCard(balanceCents = 10000) {
  const card = await giftCardsService.createPendingGiftCard({
    initialAmountCents: balanceCents,
    purchasedByUserId: new ObjectId(),
    purchaserEmail: 'buyer@example.com',
  });
  await giftCardsService.activateGiftCard({ giftCardId: card._id, amountCents: balanceCents, paymentId: new ObjectId() });
  return giftCardsService.getGiftCardByCode(card.code);
}

describe('giftCardsService.createPendingGiftCard / activateGiftCard', () => {
  it('starts at zero balance and only becomes spendable after activation', async () => {
    const card = await giftCardsService.createPendingGiftCard({
      initialAmountCents: 5000,
      purchasedByUserId: null,
      purchaserEmail: 'guest@example.com',
    });
    expect(card.status).toBe('pending');
    expect(card.balanceCents).toBe(0);

    await expect(giftCardsService.redeemUpTo({ code: card.code, maxAmountCents: 1000 })).rejects.toMatchObject({
      statusCode: 400,
    });

    await giftCardsService.activateGiftCard({ giftCardId: card._id, amountCents: 5000, paymentId: new ObjectId() });
    const activated = await giftCardsService.getGiftCardByCode(card.code);
    expect(activated.status).toBe('active');
    expect(activated.balanceCents).toBe(5000);
  });

  it('is idempotent — activating twice does not double the balance', async () => {
    const card = await giftCardsService.createPendingGiftCard({
      initialAmountCents: 5000,
      purchasedByUserId: null,
      purchaserEmail: 'guest@example.com',
    });
    await giftCardsService.activateGiftCard({ giftCardId: card._id, amountCents: 5000, paymentId: new ObjectId() });
    await giftCardsService.activateGiftCard({ giftCardId: card._id, amountCents: 5000, paymentId: new ObjectId() });
    const activated = await giftCardsService.getGiftCardByCode(card.code);
    expect(activated.balanceCents).toBe(5000);
  });
});

describe('giftCardsService.redeemUpTo — atomic balance floor', () => {
  it('redeems up to the requested cap, capped at the remaining balance', async () => {
    const card = await activeCard(10000);
    const first = await giftCardsService.redeemUpTo({ code: card.code, maxAmountCents: 3000 });
    expect(first.valueCents).toBe(3000);

    const second = await giftCardsService.redeemUpTo({ code: card.code, maxAmountCents: 100000 });
    expect(second.valueCents).toBe(7000); // only what remained

    const depleted = await giftCardsService.getGiftCardByCode(card.code);
    expect(depleted.balanceCents).toBe(0);
    expect(depleted.redemptions).toHaveLength(2);
  });

  it('rejects redemption against an unknown code', async () => {
    await expect(giftCardsService.redeemUpTo({ code: 'NOTREAL', maxAmountCents: 100 })).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it('lets two concurrent redemptions together never exceed the balance', async () => {
    const card = await activeCard(10000);
    const results = await Promise.allSettled([
      giftCardsService.redeemUpTo({ code: card.code, maxAmountCents: 8000 }),
      giftCardsService.redeemUpTo({ code: card.code, maxAmountCents: 8000 }),
    ]);
    const totalRedeemed = results
      .filter((r) => r.status === 'fulfilled')
      .reduce((sum, r) => sum + r.value.valueCents, 0);
    expect(totalRedeemed).toBeLessThanOrEqual(10000);

    const finalCard = await giftCardsService.getGiftCardByCode(card.code);
    expect(finalCard.balanceCents).toBe(10000 - totalRedeemed);
    expect(finalCard.balanceCents).toBeGreaterThanOrEqual(0);
  });
});
