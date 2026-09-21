import { ObjectId } from 'mongodb';
import { setTestDb } from '../../src/config/db.js';
import { createFakeDb } from '../helpers/fakeDb.js';
import { createTestService, createTestEmployee, futureDateString } from '../helpers/fixtures.js';
import * as bookingService from '../../src/services/bookingService.js';
import * as paymentsService from '../../src/services/paymentsService.js';
import * as loyaltyService from '../../src/services/loyaltyService.js';
import * as discountsService from '../../src/services/discountsService.js';
import { appointmentsCollection, appointmentsIndexes } from '../../src/models/appointments.js';
import { giftCardsCollection, giftCardsIndexes } from '../../src/models/giftCards.js';
import { paymentsCollection, paymentsIndexes } from '../../src/models/payments.js';
import { activityLogCollection } from '../../src/models/activityLog.js';
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
});

// Regression for a real production incident: every payment doc used to be inserted with
// an explicit `yocoCheckoutId: null` before Yoco responded. yocoCheckoutId is unique+
// sparse, but a *sparse* index still indexes an explicit null (it only skips a genuinely
// missing field) — so only the very first payment ever created could have a null
// yocoCheckoutId; every payment after that collided with E11000 and booking/gift-card
// checkout broke outright. Scoped to its own beforeEach (rather than the file-wide one
// above) since most other tests in this file reuse fakeYoco()'s default checkout id
// across multiple payments within a single test — harmless when nothing enforces
// uniqueness, but a real collision once it's turned on, and that's a fixture artifact
// unrelated to what this regression is actually about.
describe('payments — yocoCheckoutId uniqueness', () => {
  beforeEach(async () => {
    await paymentsCollection().createIndexes(paymentsIndexes);
  });

  it('lets two different pending Yoco checkouts be created back to back without colliding', async () => {
    const userId1 = new ObjectId();
    const userId2 = new ObjectId();
    const appointment1 = await bookAppointment({ userId: userId1, startTime: '10:00' });
    const appointment2 = await bookAppointment({ userId: userId2, startTime: '13:00' });

    const first = await paymentsService.initiateBookingDepositPayment({
      appointmentId: appointment1._id,
      actor: { _id: userId1, role: ROLES.CUSTOMER },
      yoco: fakeYoco({ checkoutId: 'checkout_a' }),
    });
    const second = await paymentsService.initiateBookingDepositPayment({
      appointmentId: appointment2._id,
      actor: { _id: userId2, role: ROLES.CUSTOMER },
      yoco: fakeYoco({ checkoutId: 'checkout_b' }),
    });

    expect(first.yocoCheckoutId).toBe('checkout_a');
    expect(second.yocoCheckoutId).toBe('checkout_b');
  });
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

  it('does not reuse a stale pending payment that never got a real checkout back from Yoco, and creates a working one instead', async () => {
    const userId = new ObjectId();
    const appointment = await bookAppointment({ userId });
    const actor = { _id: userId, role: ROLES.CUSTOMER };

    // Simulates a previous attempt that reserved a payment record but failed before Yoco
    // ever returned a checkout — e.g. a transient Yoco error, or a rejected request.
    await paymentsCollection().insertOne({
      appointmentId: appointment._id,
      userId,
      guestEmail: null,
      purpose: 'booking_deposit',
      amountCents: appointment.depositCents,
      currency: 'ZAR',
      status: 'pending',
      yocoCheckoutId: null,
      redirectUrl: null,
      refunds: [],
      refundedAmountCents: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const yoco = fakeYoco({ checkoutId: 'checkout_recovered' });
    const payment = await paymentsService.initiateBookingDepositPayment({ appointmentId: appointment._id, actor, yoco });

    expect(payment.redirectUrl).toBeTruthy();
    expect(payment.redirectUrl).toContain('checkout_recovered');
    expect(yoco.counts.checkoutCalls).toBe(1);

    const stale = await paymentsCollection().findOne({ appointmentId: appointment._id, status: 'failed' });
    expect(stale).toBeTruthy();
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

  it('rejects initiating payment once another booking has since been confirmed for the same slot, and cancels the now-unviable appointment', async () => {
    const userA = new ObjectId();
    const userB = new ObjectId();
    // Both hold a pending appointment for the same slot at once — allowed, since neither
    // has paid yet (only a confirmed appointment blocks a slot).
    const service = await createTestService({ priceCents: 30000 });
    const employee = await createTestEmployee();
    const appointmentA = await bookingService.createAppointment({
      userId: String(userA),
      employeeId: String(employee._id),
      serviceIds: [String(service._id)],
      date: DATE,
      startTime: '10:00',
    });
    const appointmentB = await bookingService.createAppointment({
      userId: String(userB),
      employeeId: String(employee._id),
      serviceIds: [String(service._id)],
      date: DATE,
      startTime: '10:00',
    });

    // A pays and is confirmed first.
    await appointmentsCollection().updateOne({ _id: appointmentA._id }, { $set: { status: 'confirmed' } });

    // B tries to pay for the same slot — too late, it's gone.
    await expect(
      paymentsService.initiateBookingDepositPayment({
        appointmentId: appointmentB._id,
        actor: { _id: userB, role: ROLES.CUSTOMER },
        yoco: fakeYoco(),
      })
    ).rejects.toMatchObject({ statusCode: 409 });

    const stale = await bookingService.getAppointment(appointmentB._id);
    expect(stale.status).toBe('cancelled');
    expect(stale.cancelReason).toMatch(/taken by another confirmed booking/i);
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

  it('the second of two racing confirmations for the same slot is cancelled and flagged for review, not left to crash the webhook', async () => {
    const userA = new ObjectId();
    const userB = new ObjectId();
    const service = await createTestService({ priceCents: 30000 });
    const employee = await createTestEmployee();

    const appointmentA = await bookingService.createAppointment({
      userId: String(userA),
      employeeId: String(employee._id),
      serviceIds: [String(service._id)],
      date: DATE,
      startTime: '10:00',
    });
    const appointmentB = await bookingService.createAppointment({
      userId: String(userB),
      employeeId: String(employee._id),
      serviceIds: [String(service._id)],
      date: DATE,
      startTime: '10:00',
    });

    const paymentA = await paymentsService.initiateBookingDepositPayment({
      appointmentId: appointmentA._id,
      actor: { _id: userA, role: ROLES.CUSTOMER },
      yoco: fakeYoco({ checkoutId: 'checkout_a' }),
    });
    const paymentB = await paymentsService.initiateBookingDepositPayment({
      appointmentId: appointmentB._id,
      actor: { _id: userB, role: ROLES.CUSTOMER },
      yoco: fakeYoco({ checkoutId: 'checkout_b' }),
    });

    // A's webhook lands first and wins the slot.
    await paymentsService.handlePaymentSucceeded({ paymentId: paymentA._id, yocoPaymentId: 'pay_a' });
    // B's webhook lands moments later for a slot that's now already confirmed — must not throw.
    await expect(
      paymentsService.handlePaymentSucceeded({ paymentId: paymentB._id, yocoPaymentId: 'pay_b' })
    ).resolves.toBeUndefined();

    expect((await bookingService.getAppointment(appointmentA._id)).status).toBe('confirmed');
    const loserAppointment = await bookingService.getAppointment(appointmentB._id);
    expect(loserAppointment.status).toBe('cancelled');
    expect(loserAppointment.cancelReason).toMatch(/taken by another confirmed booking/i);

    // B's payment is still marked paid (real money moved) — surfaced for a human to
    // refund, not silently dropped.
    expect((await paymentsService.getPayment(paymentB._id)).status).toBe('paid');
    const reviewEntries = (await (await activityLogCollection().find({ type: 'payment_needs_review' })).toArray());
    expect(reviewEntries).toHaveLength(1);
    expect(reviewEntries[0].message).toMatch(/already been confirmed for the same slot/i);
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

