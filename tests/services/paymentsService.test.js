import { ObjectId } from 'mongodb';
import { setTestDb } from '../../src/config/db.js';
import { createFakeDb } from '../helpers/fakeDb.js';
import { createTestService, createTestEmployee, futureDateString } from '../helpers/fixtures.js';
import * as bookingService from '../../src/services/bookingService.js';
import * as paymentsService from '../../src/services/paymentsService.js';
import * as loyaltyService from '../../src/services/loyaltyService.js';
import * as discountsService from '../../src/services/discountsService.js';
import * as subscriptionPlansService from '../../src/services/subscriptionPlansService.js';
import * as subscriptionsService from '../../src/services/subscriptionsService.js';
import { appointmentsCollection, appointmentsIndexes } from '../../src/models/appointments.js';
import { giftCardsCollection, giftCardsIndexes } from '../../src/models/giftCards.js';
import { subscriptionsCollection, subscriptionsIndexes } from '../../src/models/subscriptions.js';
import { ROLES, MIN_CHARGE_CENTS } from '../../src/config/constants.js';

const DATE = futureDateString();

function fakeYoco({ checkoutId = 'checkout_test_1', refundStatus = 'succeeded' } = {}) {
  let checkoutCalls = 0;
  let refundCalls = 0;
  return {
    async createCheckout(args) {
      checkoutCalls += 1;
      return { id: checkoutId, redirectUrl: `https://c.yoco.com/checkout/${checkoutId}`, ...args };
    },
    async createRefund() {
      refundCalls += 1;
      return { id: checkoutId, refundId: `rfd_${refundCalls}`, status: refundStatus, message: 'ok' };
    },
    get counts() {
      return { checkoutCalls, refundCalls };
    },
  };
}

async function bookAppointment({ userId, startTime = '10:00' } = {}) {
  const service = await createTestService({ priceCents: 30000 });
  const employee = await createTestEmployee();
  return bookingService.createAppointment({
    userId: userId ? String(userId) : undefined,
    guestInfo: userId ? undefined : { name: 'Guest', email: 'guest@example.com', phone: '0821234567' },
    employeeId: String(employee._id),
    serviceIds: [String(service._id)],
    date: DATE,
    startTime,
  });
}

beforeEach(async () => {
  setTestDb(createFakeDb());
  await appointmentsCollection().createIndexes(appointmentsIndexes);
  await giftCardsCollection().createIndexes(giftCardsIndexes);
  await subscriptionsCollection().createIndexes(subscriptionsIndexes);
});

describe('paymentsService.initiateBookingDepositPayment', () => {
  it('creates a pending payment and a Yoco checkout for the deposit amount', async () => {
    const userId = new ObjectId();
    const appointment = await bookAppointment({ userId });
    const yoco = fakeYoco();

    const payment = await paymentsService.initiateBookingDepositPayment({
      appointmentId: appointment._id,
      actor: { _id: userId, role: ROLES.CUSTOMER },
      yoco,
    });

    expect(payment.amountCents).toBe(appointment.depositCents);
    expect(payment.status).toBe('pending');
    expect(payment.yocoCheckoutId).toBe('checkout_test_1');
    expect(payment.redirectUrl).toContain('checkout_test_1');
    expect(yoco.counts.checkoutCalls).toBe(1);
  });

  it('reuses an existing pending payment instead of creating a second checkout', async () => {
    const userId = new ObjectId();
    const appointment = await bookAppointment({ userId });
    const yoco = fakeYoco();
    const actor = { _id: userId, role: ROLES.CUSTOMER };

    const first = await paymentsService.initiateBookingDepositPayment({ appointmentId: appointment._id, actor, yoco });
    const second = await paymentsService.initiateBookingDepositPayment({ appointmentId: appointment._id, actor, yoco });

    expect(String(second._id)).toBe(String(first._id));
    expect(yoco.counts.checkoutCalls).toBe(1);
  });

  it('lets a guest initiate payment for their own guest booking with no auth', async () => {
    const appointment = await bookAppointment({});
    const payment = await paymentsService.initiateBookingDepositPayment({
      appointmentId: appointment._id,
      actor: null,
      yoco: fakeYoco(),
    });
    expect(payment.guestEmail).toBe('guest@example.com');
  });

  it("rejects a customer initiating payment for someone else's booking", async () => {
    const owner = new ObjectId();
    const stranger = new ObjectId();
    const appointment = await bookAppointment({ userId: owner });

    await expect(
      paymentsService.initiateBookingDepositPayment({
        appointmentId: appointment._id,
        actor: { _id: stranger, role: ROLES.CUSTOMER },
        yoco: fakeYoco(),
      })
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('rejects initiating payment for an appointment that is not pending_payment', async () => {
    const userId = new ObjectId();
    const appointment = await bookAppointment({ userId });
    await appointmentsCollection().updateOne({ _id: appointment._id }, { $set: { status: 'cancelled' } });

    await expect(
      paymentsService.initiateBookingDepositPayment({
        appointmentId: appointment._id,
        actor: { _id: userId, role: ROLES.CUSTOMER },
        yoco: fakeYoco(),
      })
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('paymentsService.handlePaymentSucceeded — webhook idempotency', () => {
  it('confirms the appointment and marks the payment paid exactly once', async () => {
    const userId = new ObjectId();
    const appointment = await bookAppointment({ userId });
    const payment = await paymentsService.initiateBookingDepositPayment({
      appointmentId: appointment._id,
      actor: { _id: userId, role: ROLES.CUSTOMER },
      yoco: fakeYoco(),
    });

    await paymentsService.handlePaymentSucceeded({ paymentId: payment._id, yocoPaymentId: 'pay_123' });

    const paidPayment = await paymentsService.getPayment(payment._id);
    expect(paidPayment.status).toBe('paid');
    const confirmedAppointment = await bookingService.getAppointment(appointment._id);
    expect(confirmedAppointment.status).toBe('confirmed');
    expect(String(confirmedAppointment.paymentId)).toBe(String(payment._id));
  });

  it('is a true no-op on replay — a second delivery cannot undo manual admin changes made in between', async () => {
    const userId = new ObjectId();
    const appointment = await bookAppointment({ userId });
    const payment = await paymentsService.initiateBookingDepositPayment({
      appointmentId: appointment._id,
      actor: { _id: userId, role: ROLES.CUSTOMER },
      yoco: fakeYoco(),
    });

    await paymentsService.handlePaymentSucceeded({ paymentId: payment._id, yocoPaymentId: 'pay_123' });

    // Admin cancels the appointment after confirmation (e.g. client called in).
    await appointmentsCollection().updateOne(
      { _id: appointment._id },
      { $set: { status: 'cancelled', cancelledAt: new Date() } }
    );

    // A redelivered webhook for the same event must not flip it back to confirmed —
    // the payment is already 'paid', so the guarded findOneAndUpdate matches nothing.
    await paymentsService.handlePaymentSucceeded({ paymentId: payment._id, yocoPaymentId: 'pay_123' });

    const stillCancelled = await bookingService.getAppointment(appointment._id);
    expect(stillCancelled.status).toBe('cancelled');
  });

  it('does nothing for an unknown payment id (e.g. a stale/foreign event)', async () => {
    await expect(
      paymentsService.handlePaymentSucceeded({ paymentId: new ObjectId(), yocoPaymentId: 'pay_x' })
    ).resolves.toBeUndefined();
  });
});

describe('paymentsService.refundPayment', () => {
  async function paidPayment() {
    const userId = new ObjectId();
    const appointment = await bookAppointment({ userId });
    const payment = await paymentsService.initiateBookingDepositPayment({
      appointmentId: appointment._id,
      actor: { _id: userId, role: ROLES.CUSTOMER },
      yoco: fakeYoco(),
    });
    await paymentsService.handlePaymentSucceeded({ paymentId: payment._id, yocoPaymentId: 'pay_123' });
    return { payment: await paymentsService.getPayment(payment._id), appointment, userId };
  }

  it('fully refunds a payment and cancels the linked appointment', async () => {
    const { payment } = await paidPayment();
    const adminId = new ObjectId();

    const refunded = await paymentsService.refundPayment({
      paymentId: payment._id,
      reason: 'Client cancelled',
      actor: { _id: adminId, role: ROLES.ADMIN },
      yoco: fakeYoco(),
    });

    expect(refunded.status).toBe('refunded');
    expect(refunded.refundedAmountCents).toBe(payment.amountCents);
    expect(refunded.refunds).toHaveLength(1);
    expect(refunded.refunds[0]).toMatchObject({ amountCents: payment.amountCents, reason: 'Client cancelled', status: 'succeeded' });
    const appointment = await bookingService.getAppointment(payment.appointmentId);
    expect(appointment.status).toBe('cancelled');
  });

  it('supports a partial refund without cancelling the appointment', async () => {
    const { payment } = await paidPayment();
    const partial = Math.floor(payment.amountCents / 2);

    const refunded = await paymentsService.refundPayment({
      paymentId: payment._id,
      amountCents: partial,
      actor: { _id: new ObjectId(), role: ROLES.ADMIN },
      yoco: fakeYoco(),
    });

    expect(refunded.status).toBe('partially_refunded');
    const appointment = await bookingService.getAppointment(payment.appointmentId);
    expect(appointment.status).toBe('confirmed');
  });

  it('rejects refunding more than remains available', async () => {
    const { payment } = await paidPayment();
    await expect(
      paymentsService.refundPayment({
        paymentId: payment._id,
        amountCents: payment.amountCents + 1,
        actor: { _id: new ObjectId(), role: ROLES.ADMIN },
        yoco: fakeYoco(),
      })
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('lets only one of two concurrent refunds win once the balance is exhausted', async () => {
    const { payment } = await paidPayment();
    const admin = { _id: new ObjectId(), role: ROLES.ADMIN };

    const attempt = () =>
      paymentsService.refundPayment({
        paymentId: payment._id,
        amountCents: payment.amountCents, // each tries to take the full amount
        actor: admin,
        yoco: fakeYoco(),
      });

    const results = await Promise.allSettled([attempt(), attempt()]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const finalPayment = await paymentsService.getPayment(payment._id);
    expect(finalPayment.refundedAmountCents).toBe(payment.amountCents);
  });
});

describe('paymentsService.initiateBookingDepositPayment — discount + points redemption', () => {
  it('applies a discount code to reduce the charged amount', async () => {
    const userId = new ObjectId();
    const appointment = await bookAppointment({ userId });
    await discountsService.createDiscountCode({ code: 'SAVE20', type: 'fixed', value: 2000 });

    const payment = await paymentsService.initiateBookingDepositPayment({
      appointmentId: appointment._id,
      actor: { _id: userId, role: ROLES.CUSTOMER },
      discountCode: 'save20',
      yoco: fakeYoco(),
    });

    expect(payment.originalAmountCents).toBe(appointment.depositCents);
    expect(payment.discountValueCents).toBe(2000);
    expect(payment.amountCents).toBe(appointment.depositCents - 2000);
  });

  it('applies loyalty points capped at the configured max-redemption percentage', async () => {
    const userId = new ObjectId();
    const appointment = await bookAppointment({ userId });
    await loyaltyService.awardPoints({ userId, points: 100000, source: 'test-setup' }); // way more than needed

    const payment = await paymentsService.initiateBookingDepositPayment({
      appointmentId: appointment._id,
      actor: { _id: userId, role: ROLES.CUSTOMER },
      pointsToRedeem: 100000,
      yoco: fakeYoco(),
    });

    // Never more than 50% of the original deposit, regardless of how many points were requested.
    expect(payment.redemptionValueCents).toBeLessThanOrEqual(Math.floor(appointment.depositCents * 0.5));
    expect(payment.amountCents).toBe(appointment.depositCents - payment.redemptionValueCents);

    const ledger = await loyaltyService.getLedger(userId);
    expect(ledger.pointsBalance).toBe(100000 - payment.pointsRedeemed);
  });

  it('never lets a stacked discount + redemption reduce the charge below the minimum', async () => {
    const userId = new ObjectId();
    const appointment = await bookAppointment({ userId });
    await discountsService.createDiscountCode({ code: 'HUGE', type: 'fixed', value: appointment.depositCents });
    await loyaltyService.awardPoints({ userId, points: 100000, source: 'test-setup' });

    const payment = await paymentsService.initiateBookingDepositPayment({
      appointmentId: appointment._id,
      actor: { _id: userId, role: ROLES.CUSTOMER },
      discountCode: 'HUGE',
      pointsToRedeem: 100000,
      yoco: fakeYoco(),
    });

    expect(payment.amountCents).toBe(MIN_CHARGE_CENTS);
  });

  it("does not let an admin spend the appointment owner's points when booking on their behalf", async () => {
    const userId = new ObjectId();
    const appointment = await bookAppointment({ userId });
    await loyaltyService.awardPoints({ userId, points: 100000, source: 'test-setup' });

    const payment = await paymentsService.initiateBookingDepositPayment({
      appointmentId: appointment._id,
      actor: { _id: new ObjectId(), role: ROLES.ADMIN },
      pointsToRedeem: 100000,
      yoco: fakeYoco(),
    });

    expect(payment.pointsRedeemed).toBe(0);
    expect(payment.amountCents).toBe(appointment.depositCents);
  });
});

describe('paymentsService.initiateGiftCardPurchase + activation', () => {
  it('creates a pending gift card and payment, then activates the card on webhook success', async () => {
    const purchase = await paymentsService.initiateGiftCardPurchase({
      amountCents: 20000,
      purchaserUserId: null,
      purchaserEmail: 'buyer@example.com',
      recipientEmail: 'friend@example.com',
      yoco: fakeYoco(),
    });
    expect(purchase.status).toBe('pending');

    await paymentsService.handlePaymentSucceeded({ paymentId: purchase._id, yocoPaymentId: 'pay_gc_1' });

    const giftCard = await giftCardsCollection().findOne({ _id: purchase.giftCardId });
    expect(giftCard.status).toBe('active');
    expect(giftCard.balanceCents).toBe(20000);
  });

  it('rejects an amount outside the configured bounds', async () => {
    await expect(
      paymentsService.initiateGiftCardPurchase({
        amountCents: 1,
        purchaserUserId: null,
        purchaserEmail: 'buyer@example.com',
        yoco: fakeYoco(),
      })
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('paymentsService.initiateBookingDepositPayment — gift card redemption', () => {
  it('applies a gift card balance to reduce the charge, stacked with a discount', async () => {
    const userId = new ObjectId();
    const appointment = await bookAppointment({ userId });

    const purchase = await paymentsService.initiateGiftCardPurchase({
      amountCents: 50000,
      purchaserUserId: null,
      purchaserEmail: 'buyer@example.com',
      yoco: fakeYoco(),
    });
    await paymentsService.handlePaymentSucceeded({ paymentId: purchase._id, yocoPaymentId: 'pay_gc_2' });
    const giftCard = await giftCardsCollection().findOne({ _id: purchase.giftCardId });

    await discountsService.createDiscountCode({ code: 'GCTEST', type: 'fixed', value: 2000 });

    const payment = await paymentsService.initiateBookingDepositPayment({
      appointmentId: appointment._id,
      actor: { _id: userId, role: ROLES.CUSTOMER },
      discountCode: 'GCTEST',
      giftCardCode: giftCard.code,
      yoco: fakeYoco(),
    });

    expect(payment.discountValueCents).toBe(2000);
    expect(payment.giftCardValueCents).toBe(appointment.depositCents - 2000 - MIN_CHARGE_CENTS);
    expect(payment.amountCents).toBe(MIN_CHARGE_CENTS);

    const spentCard = await giftCardsCollection().findOne({ _id: giftCard._id });
    expect(spentCard.balanceCents).toBe(50000 - payment.giftCardValueCents);
  });

  it('never over-redeems a gift card even if its balance is smaller than the deposit', async () => {
    const userId = new ObjectId();
    const appointment = await bookAppointment({ userId });

    const purchase = await paymentsService.initiateGiftCardPurchase({
      amountCents: 5000, // less than the deposit
      purchaserUserId: null,
      purchaserEmail: 'buyer@example.com',
      yoco: fakeYoco(),
    });
    await paymentsService.handlePaymentSucceeded({ paymentId: purchase._id, yocoPaymentId: 'pay_gc_3' });
    const giftCard = await giftCardsCollection().findOne({ _id: purchase.giftCardId });

    const payment = await paymentsService.initiateBookingDepositPayment({
      appointmentId: appointment._id,
      actor: { _id: userId, role: ROLES.CUSTOMER },
      giftCardCode: giftCard.code,
      yoco: fakeYoco(),
    });

    expect(payment.giftCardValueCents).toBe(5000);
    expect(payment.amountCents).toBe(appointment.depositCents - 5000);

    const spentCard = await giftCardsCollection().findOne({ _id: giftCard._id });
    expect(spentCard.balanceCents).toBe(0);
  });
});

describe('paymentsService.initiateSubscriptionPurchase + activation', () => {
  it('activates the subscription with a fresh credit balance once payment succeeds', async () => {
    const userId = new ObjectId();
    const plan = await subscriptionPlansService.createPlan({
      name: 'Monthly Glow',
      priceCents: 50000,
      creditsPerPeriod: 4,
      periodDays: 30,
    });

    const purchase = await paymentsService.initiateSubscriptionPurchase({ userId, planId: plan._id, yoco: fakeYoco() });
    expect(purchase.amountCents).toBe(50000);

    await paymentsService.handlePaymentSucceeded({ paymentId: purchase._id, yocoPaymentId: 'pay_sub_1' });

    const subscription = await subscriptionsService.getUserSubscription(userId);
    expect(subscription.status).toBe('active');
    expect(subscription.creditsRemaining).toBe(4);
  });
});

describe('paymentsService.initiateBookingDepositPayment — subscription credit', () => {
  it('covers the deposit with a credit, bypassing Yoco entirely', async () => {
    const userId = new ObjectId();
    const appointment = await bookAppointment({ userId });

    const plan = await subscriptionPlansService.createPlan({
      name: 'Monthly Glow',
      priceCents: 50000,
      creditsPerPeriod: 2,
      periodDays: 30,
    });
    const purchase = await paymentsService.initiateSubscriptionPurchase({ userId, planId: plan._id, yoco: fakeYoco() });
    await paymentsService.handlePaymentSucceeded({ paymentId: purchase._id, yocoPaymentId: 'pay_sub_2' });

    const payment = await paymentsService.initiateBookingDepositPayment({
      appointmentId: appointment._id,
      actor: { _id: userId, role: ROLES.CUSTOMER },
      useSubscriptionCredit: true,
      yoco: fakeYoco(),
    });

    expect(payment.status).toBe('paid');
    expect(payment.amountCents).toBe(0);
    expect(payment.redirectUrl).toBeNull();

    const confirmed = await bookingService.getAppointment(appointment._id);
    expect(confirmed.status).toBe('confirmed');

    const subscription = await subscriptionsService.getUserSubscription(userId);
    expect(subscription.creditsRemaining).toBe(1);
  });

  it('rejects a second checkout attempt for the same appointment once a credit confirmed it', async () => {
    const userId = new ObjectId();
    const appointment = await bookAppointment({ userId });
    const plan = await subscriptionPlansService.createPlan({
      name: 'Monthly Glow',
      priceCents: 50000,
      creditsPerPeriod: 2,
      periodDays: 30,
    });
    const purchase = await paymentsService.initiateSubscriptionPurchase({ userId, planId: plan._id, yoco: fakeYoco() });
    await paymentsService.handlePaymentSucceeded({ paymentId: purchase._id, yocoPaymentId: 'pay_sub_3' });

    await paymentsService.initiateBookingDepositPayment({
      appointmentId: appointment._id,
      actor: { _id: userId, role: ROLES.CUSTOMER },
      useSubscriptionCredit: true,
      yoco: fakeYoco(),
    });

    await expect(
      paymentsService.initiateBookingDepositPayment({
        appointmentId: appointment._id,
        actor: { _id: userId, role: ROLES.CUSTOMER },
        yoco: fakeYoco(),
      })
    ).rejects.toMatchObject({ statusCode: 400 });

    // And the credit wasn't spent twice either.
    const subscription = await subscriptionsService.getUserSubscription(userId);
    expect(subscription.creditsRemaining).toBe(1);
  });

  it('does not let an admin spend a credit on the appointment owner\'s behalf', async () => {
    const userId = new ObjectId();
    const appointment = await bookAppointment({ userId });
    const plan = await subscriptionPlansService.createPlan({
      name: 'Monthly Glow',
      priceCents: 50000,
      creditsPerPeriod: 2,
      periodDays: 30,
    });
    const purchase = await paymentsService.initiateSubscriptionPurchase({ userId, planId: plan._id, yoco: fakeYoco() });
    await paymentsService.handlePaymentSucceeded({ paymentId: purchase._id, yocoPaymentId: 'pay_sub_4' });

    const payment = await paymentsService.initiateBookingDepositPayment({
      appointmentId: appointment._id,
      actor: { _id: new ObjectId(), role: ROLES.ADMIN },
      useSubscriptionCredit: true,
      yoco: fakeYoco(),
    });

    expect(payment.status).toBe('pending'); // fell through to the normal Yoco flow
    const subscription = await subscriptionsService.getUserSubscription(userId);
    expect(subscription.creditsRemaining).toBe(2); // untouched
  });
});
