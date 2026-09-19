import { ObjectId } from 'mongodb';
import { paymentsCollection } from '../models/payments.js';
import { appointmentsCollection } from '../models/appointments.js';
import { usersCollection } from '../models/users.js';
import * as defaultYoco from '../config/yocoClient.js';
import { createClientNotification } from './clientNotificationsService.js';
import { logActivity } from './activityLogService.js';
import { awardPoints, previewRedemption, redeemPoints } from './loyaltyService.js';
import { completeReferralIfPending } from './referralService.js';
import { getSettings } from './settingsService.js';
import { validateDiscountCode, redeemDiscountCode } from './discountsService.js';
import * as giftCardsService from './giftCardsService.js';
import * as subscriptionsService from './subscriptionsService.js';
import { getPlan } from './subscriptionPlansService.js';
import { sendMail } from '../config/mailer.js';
import { env } from '../config/env.js';
import {
  PAYMENT_STATUS,
  PAYMENT_PURPOSE,
  APPOINTMENT_STATUS,
  MIN_CHARGE_CENTS,
  GIFT_CARD_MIN_CENTS,
  GIFT_CARD_MAX_CENTS,
} from '../config/constants.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../utils/AppError.js';

export function assertPaymentAccess(payment, actor) {
  if (actor.role === 'admin') return;
  if (!payment.userId || String(payment.userId) !== String(actor._id)) {
    throw forbidden('You do not have access to this payment.');
  }
}

export async function getPayment(id) {
  const payment = await paymentsCollection().findOne({ _id: new ObjectId(id) });
  if (!payment) throw notFound('Payment');
  return payment;
}

// §5.1 — amountCents always comes from the appointment's server-computed depositCents,
// never from the request. §4.4 — if a payment for this appointment is already pending,
// its existing checkout is reused rather than spawning a second Yoco checkout session.
export async function initiateBookingDepositPayment({
  appointmentId,
  actor,
  pointsToRedeem = 0,
  discountCode = null,
  giftCardCode = null,
  useSubscriptionCredit = false,
  yoco = defaultYoco,
}) {
  const appointment = await appointmentsCollection().findOne({ _id: new ObjectId(appointmentId) });
  if (!appointment) throw notFound('Appointment');

  const isOwner = appointment.userId && String(appointment.userId) === String(actor?._id);
  const isAdmin = actor?.role === 'admin';
  const isUnclaimedGuestBooking = !appointment.userId && !actor;
  if (!isOwner && !isAdmin && !isUnclaimedGuestBooking) {
    throw forbidden('You do not have access to this appointment.');
  }

  if (appointment.status !== APPOINTMENT_STATUS.PENDING_PAYMENT) {
    throw badRequest('This appointment is not awaiting payment.');
  }

  // §4.8 — a subscription credit fully covers the deposit and bypasses Yoco entirely
  // (no discount/points/gift-card stacking makes sense against a R0 charge). Only the
  // appointment's own owner can spend their own credit — same rule as loyalty points.
  // Consuming the credit is atomic (subscriptionsService.useCredit); if that succeeds,
  // confirming the appointment happens synchronously here rather than via webhook, so a
  // second call for the same appointment is blocked by the PENDING_PAYMENT check above
  // once this one flips it to CONFIRMED — no separate dedup needed for this path.
  if (useSubscriptionCredit && isOwner) {
    await subscriptionsService.useCredit({ userId: appointment.userId });
    const now = new Date();
    const doc = {
      purpose: PAYMENT_PURPOSE.BOOKING_DEPOSIT,
      appointmentId: appointment._id,
      giftCardId: null,
      subscriptionId: null,
      userId: appointment.userId,
      guestEmail: null,
      amountCents: 0,
      originalAmountCents: appointment.depositCents,
      pointsRedeemed: 0,
      redemptionValueCents: 0,
      discountCode: null,
      discountValueCents: 0,
      giftCardCode: null,
      giftCardValueCents: 0,
      currency: 'ZAR',
      status: PAYMENT_STATUS.PAID,
      // yocoCheckoutId deliberately omitted, not set to null — this path pays via
      // subscription credit and never touches Yoco, so there's never a real value coming.
      // yocoCheckoutId has a unique+sparse index (models/payments.js); a *sparse* index
      // still indexes an explicit null (it only skips a genuinely missing field), so
      // setting it to null here would let only one such payment ever exist before every
      // later one collided with E11000 — exactly the bug this fixes (see README).
      yocoPaymentId: null,
      redirectUrl: null,
      refunds: [],
      refundedAmountCents: 0,
      createdAt: now,
      updatedAt: now,
    };
    const { insertedId } = await paymentsCollection().insertOne(doc);
    const paid = { ...doc, _id: insertedId };
    await confirmAppointmentForPaidDeposit(paid);
    return paid;
  }

  const existing = await paymentsCollection().findOne({
    appointmentId: appointment._id,
    status: PAYMENT_STATUS.PENDING,
  });
  if (existing) return existing;

  const originalAmountCents = appointment.depositCents;
  let amountCents = originalAmountCents;
  let discountValueCents = 0;
  let appliedDiscountCode = null;
  let pointsRedeemed = 0;
  let redemptionValueCents = 0;

  // §4.9 — validated and atomically redeemed (usage-limit decrement) before the charge
  // amount is finalized; never trust a discount's value without going through this.
  if (discountCode) {
    const { discountValueCents: value } = await validateDiscountCode({ code: discountCode, amountCents });
    await redeemDiscountCode(discountCode);
    appliedDiscountCode = discountCode.toUpperCase();
    discountValueCents = value;
    amountCents -= discountValueCents;
  }

  // §4.5 — only the appointment's own owner can spend their own points (never an admin
  // booking on their behalf, never a guest — guests have no loyalty account). The cap is
  // computed against the original deposit, not the discount-reduced amount.
  if (pointsToRedeem > 0 && isOwner) {
    const settings = await getSettings();
    const preview = await previewRedemption({ pointsRequested: pointsToRedeem, amountCents: originalAmountCents, settings });
    if (preview.points > 0) {
      const redeemed = await redeemPoints({
        userId: appointment.userId,
        points: preview.points,
        relatedAppointmentId: appointment._id,
        note: `Redeemed at checkout for booking on ${appointment.date}`,
      });
      pointsRedeemed = preview.points;
      redemptionValueCents = redeemed.valueCents;
      amountCents -= redemptionValueCents;
    }
  }

  // §4.7 — a gift card can cover the rest, but never below the same hard floor. Room is
  // computed before the floor clamp so the card isn't asked to cover more than it needs
  // to; the clamp still runs at the end as a final safety net either way.
  let giftCardValueCents = 0;
  let appliedGiftCardCode = null;
  if (giftCardCode) {
    const room = Math.max(amountCents - MIN_CHARGE_CENTS, 0);
    const redeemed = await giftCardsService.redeemUpTo({ code: giftCardCode, maxAmountCents: room, appointmentId: appointment._id });
    if (redeemed.valueCents > 0) {
      appliedGiftCardCode = giftCardCode.toUpperCase();
      giftCardValueCents = redeemed.valueCents;
      amountCents -= giftCardValueCents;
    }
  }

  amountCents = Math.max(amountCents, MIN_CHARGE_CENTS);

  const now = new Date();
  const doc = {
    purpose: PAYMENT_PURPOSE.BOOKING_DEPOSIT,
    appointmentId: appointment._id,
    giftCardId: null,
    subscriptionId: null,
    userId: appointment.userId,
    guestEmail: appointment.guestInfo?.email ?? null,
    amountCents,
    originalAmountCents,
    pointsRedeemed,
    redemptionValueCents,
    discountCode: appliedDiscountCode,
    discountValueCents,
    giftCardCode: appliedGiftCardCode,
    giftCardValueCents,
    currency: 'ZAR',
    status: PAYMENT_STATUS.PENDING,
    // yocoCheckoutId deliberately omitted here, set via $set once Yoco responds below —
    // see the PAID branch above for why an explicit null would collide on the unique+
    // sparse index.
    yocoPaymentId: null,
    redirectUrl: null,
    refunds: [],
    refundedAmountCents: 0,
    createdAt: now,
    updatedAt: now,
  };
  const { insertedId } = await paymentsCollection().insertOne(doc);

  const checkout = await yoco.createCheckout({
    amountCents: doc.amountCents,
    currency: doc.currency,
    successUrl: `${env.CLIENT_URL}/booking/confirmation?appointmentId=${appointment._id}`,
    cancelUrl: `${env.CLIENT_URL}/booking/payment?appointmentId=${appointment._id}&status=cancelled`,
    failureUrl: `${env.CLIENT_URL}/booking/payment?appointmentId=${appointment._id}&status=failed`,
    metadata: { paymentId: String(insertedId) },
    idempotencyKey: String(insertedId),
  });

  await paymentsCollection().updateOne(
    { _id: insertedId },
    { $set: { yocoCheckoutId: checkout.id, redirectUrl: checkout.redirectUrl, updatedAt: new Date() } }
  );

  return getPayment(insertedId);
}

async function sendBookingConfirmationEmail(appointment) {
  const identity = appointment.userId
    ? await usersCollection().findOne({ _id: appointment.userId })
    : appointment.guestInfo;
  const to = identity?.email;
  if (!to) return;
  const firstName = appointment.userId ? identity.firstName : identity.name;
  await sendMail({
    to,
    subject: 'Your NailsByMandisa booking is confirmed',
    html: `<p>Hi ${firstName},</p><p>Your booking on ${appointment.date} at ${appointment.startTime} is confirmed. We look forward to seeing you!</p>`,
    text: `Your booking on ${appointment.date} at ${appointment.startTime} is confirmed.`,
  });
}

// §4.7 — the redeemable code is delivered by email (both to the purchaser and, if a
// gift, to the recipient) regardless of whether the purchaser is logged in — unlike a
// booking confirmation, there's no adequate fallback in-app-only delivery for a code
// that needs to be handed to someone else.
async function sendGiftCardEmail(giftCard) {
  const recipients = new Set([giftCard.purchaserEmail, giftCard.recipientEmail].filter(Boolean));
  const amountLabel = `R${(giftCard.balanceCents / 100).toFixed(2)}`;
  await Promise.all(
    [...recipients].map((to) =>
      sendMail({
        to,
        subject: `Your NailsByMandisa gift card — ${amountLabel}`,
        html: `<p>Here is your NailsByMandisa gift card for ${amountLabel}.</p><p style="font-size:20px;font-weight:bold;">${giftCard.code}</p><p>Redeem it against any booking's deposit.</p>`,
        text: `Your NailsByMandisa gift card for ${amountLabel}: ${giftCard.code}. Redeem it against any booking's deposit.`,
      })
    )
  );
}

// §4.7 — build it fully: a real purchase flow (choose amount, pay via Yoco, code emailed
// to purchaser + optional recipient). Mirrors initiateBookingDepositPayment's shape —
// same pending-payment-then-webhook-activates pattern, same dedup-on-existing-pending
// check — so there's exactly one way this kind of flow works in this codebase.
export async function initiateGiftCardPurchase({ amountCents, purchaserUserId, purchaserEmail, recipientEmail, yoco = defaultYoco }) {
  if (amountCents < GIFT_CARD_MIN_CENTS || amountCents > GIFT_CARD_MAX_CENTS) {
    throw badRequest(`Gift card amount must be between R${GIFT_CARD_MIN_CENTS / 100} and R${GIFT_CARD_MAX_CENTS / 100}.`);
  }
  if (!purchaserEmail) throw badRequest('An email address is required to receive the gift card.');

  const giftCard = await giftCardsService.createPendingGiftCard({
    initialAmountCents: amountCents,
    purchasedByUserId: purchaserUserId,
    purchaserEmail,
    recipientEmail,
  });

  const now = new Date();
  const doc = {
    purpose: PAYMENT_PURPOSE.GIFT_CARD_PURCHASE,
    appointmentId: null,
    giftCardId: giftCard._id,
    subscriptionId: null,
    userId: purchaserUserId ? new ObjectId(purchaserUserId) : null,
    guestEmail: purchaserUserId ? null : purchaserEmail,
    amountCents,
    originalAmountCents: amountCents,
    pointsRedeemed: 0,
    redemptionValueCents: 0,
    discountCode: null,
    discountValueCents: 0,
    giftCardCode: null,
    giftCardValueCents: 0,
    currency: 'ZAR',
    status: PAYMENT_STATUS.PENDING,
    // yocoCheckoutId deliberately omitted here, set via $set once Yoco responds below —
    // see initiateBookingDepositPayment's PAID branch for why an explicit null would
    // collide on the unique+sparse index.
    yocoPaymentId: null,
    redirectUrl: null,
    refunds: [],
    refundedAmountCents: 0,
    createdAt: now,
    updatedAt: now,
  };
  const { insertedId } = await paymentsCollection().insertOne(doc);

  const checkout = await yoco.createCheckout({
    amountCents: doc.amountCents,
    currency: doc.currency,
    successUrl: `${env.CLIENT_URL}/gift-cards/confirmation?paymentId=${insertedId}`,
    cancelUrl: `${env.CLIENT_URL}/gift-cards/purchase?status=cancelled`,
    failureUrl: `${env.CLIENT_URL}/gift-cards/purchase?status=failed`,
    metadata: { paymentId: String(insertedId) },
    idempotencyKey: String(insertedId),
  });

  await paymentsCollection().updateOne(
    { _id: insertedId },
    { $set: { yocoCheckoutId: checkout.id, redirectUrl: checkout.redirectUrl, updatedAt: new Date() } }
  );

  return getPayment(insertedId);
}

// §4.8 — subscribing and renewing are the same call: upsertPendingSubscription() either
// creates the customer's one subscription document or reuses it (keeping it active
// through a renewal so they don't lose access mid-payment). No automatic recurring
// billing here — Yoco's Checkout API is one-off sessions, not a stored-card/recurring
// primitive, so renewal is a customer-triggered repeat of this same call.
export async function initiateSubscriptionPurchase({ userId, planId, yoco = defaultYoco }) {
  const plan = await getPlan(planId);
  if (!plan.isActive) throw badRequest('This plan is no longer available.');

  const subscription = await subscriptionsService.upsertPendingSubscription({ userId, planId });

  const now = new Date();
  const doc = {
    purpose: PAYMENT_PURPOSE.SUBSCRIPTION,
    appointmentId: null,
    giftCardId: null,
    subscriptionId: subscription._id,
    userId: new ObjectId(userId),
    guestEmail: null,
    amountCents: plan.priceCents,
    originalAmountCents: plan.priceCents,
    pointsRedeemed: 0,
    redemptionValueCents: 0,
    discountCode: null,
    discountValueCents: 0,
    giftCardCode: null,
    giftCardValueCents: 0,
    currency: 'ZAR',
    status: PAYMENT_STATUS.PENDING,
    // yocoCheckoutId deliberately omitted here, set via $set once Yoco responds below —
    // see initiateBookingDepositPayment's PAID branch for why an explicit null would
    // collide on the unique+sparse index.
    yocoPaymentId: null,
    redirectUrl: null,
    refunds: [],
    refundedAmountCents: 0,
    createdAt: now,
    updatedAt: now,
  };
  const { insertedId } = await paymentsCollection().insertOne(doc);

  const checkout = await yoco.createCheckout({
    amountCents: doc.amountCents,
    currency: doc.currency,
    successUrl: `${env.CLIENT_URL}/account/subscription?status=success`,
    cancelUrl: `${env.CLIENT_URL}/subscriptions/plans?status=cancelled`,
    failureUrl: `${env.CLIENT_URL}/subscriptions/plans?status=failed`,
    metadata: { paymentId: String(insertedId) },
    idempotencyKey: String(insertedId),
  });

  await paymentsCollection().updateOne(
    { _id: insertedId },
    { $set: { yocoCheckoutId: checkout.id, redirectUrl: checkout.redirectUrl, updatedAt: new Date() } }
  );

  return getPayment(insertedId);
}

// Shared by both the async Yoco webhook path (handlePaymentSucceeded) and the synchronous
// subscription-credit path (initiateBookingDepositPayment, which bypasses Yoco entirely
// when a credit covers the deposit) — §6.2, one function, every caller. `updated` is a
// payment already atomically transitioned to PAID by the caller; this only runs the
// appointment-confirmation side effects and is itself guarded by the appointment's own
// pending→confirmed transition, so it's safe even if somehow invoked twice.
async function confirmAppointmentForPaidDeposit(updated) {
  const appointment = await appointmentsCollection().findOneAndUpdate(
    { _id: updated.appointmentId, status: APPOINTMENT_STATUS.PENDING_PAYMENT },
    { $set: { status: APPOINTMENT_STATUS.CONFIRMED, paymentId: updated._id, updatedAt: new Date() } }
  );
  if (!appointment) return;

  await sendBookingConfirmationEmail(appointment);
  if (appointment.userId) {
    await createClientNotification({
      userId: appointment.userId,
      type: 'booking_confirmed',
      title: 'Booking confirmed',
      body: `Your booking on ${appointment.date} at ${appointment.startTime} is confirmed.`,
      link: `/account/bookings/${appointment._id}`,
    });

    const settings = await getSettings();
    // §4.5 — 1 point per R1 of what was actually charged (net of any discount/points
    // already applied at checkout — see initiateBookingDepositPayment). A subscription
    // credit charges R0, so it earns 0 points — consistent with "points on what was paid".
    const pointsEarned = Math.floor((updated.amountCents / 100) * settings.loyalty.pointsPerRand);
    if (pointsEarned > 0) {
      await awardPoints({
        userId: appointment.userId,
        points: pointsEarned,
        source: 'booking_deposit_payment',
        relatedPaymentId: updated._id,
        relatedAppointmentId: appointment._id,
      });
    }

    await completeReferralIfPending(appointment.userId);
  }
  await logActivity({
    type: 'payment_received',
    message: `Deposit of R${(updated.amountCents / 100).toFixed(2)} received for booking on ${appointment.date}`,
    actorUserId: appointment.userId,
    metadata: { paymentId: String(updated._id), appointmentId: String(appointment._id) },
  });
}

// §4.4/§6.1 — the core idempotency guarantee: this findOneAndUpdate only succeeds the
// FIRST time a given payment transitions out of "pending". A redelivered webhook for an
// already-processed event finds no matching document and is a silent no-op — it can
// never double-confirm a booking. Signature verification happens in the route layer
// before this is ever called (§4.4/§5.2 — fails closed, never optional).
export async function handlePaymentSucceeded({ paymentId, yocoPaymentId }) {
  const updated = await paymentsCollection().findOneAndUpdate(
    { _id: new ObjectId(paymentId), status: PAYMENT_STATUS.PENDING },
    { $set: { status: PAYMENT_STATUS.PAID, yocoPaymentId, updatedAt: new Date() } }
  );
  if (!updated) return; // already processed (replay) or unknown payment — nothing to do

  if (updated.purpose === PAYMENT_PURPOSE.BOOKING_DEPOSIT && updated.appointmentId) {
    await confirmAppointmentForPaidDeposit(updated);
  }

  if (updated.purpose === PAYMENT_PURPOSE.GIFT_CARD_PURCHASE && updated.giftCardId) {
    const giftCard = await giftCardsService.activateGiftCard({
      giftCardId: updated.giftCardId,
      amountCents: updated.amountCents,
      paymentId: updated._id,
    });
    if (giftCard) {
      await sendGiftCardEmail(giftCard);
      if (updated.userId) {
        await createClientNotification({
          userId: updated.userId,
          type: 'admin_message',
          title: 'Gift card ready',
          body: `Your R${(giftCard.balanceCents / 100).toFixed(2)} gift card is ready — code: ${giftCard.code}`,
          link: '/account/gift-cards',
        });
      }
      await logActivity({
        type: 'gift_card_purchased',
        message: `Gift card ${giftCard.code} purchased for R${(giftCard.balanceCents / 100).toFixed(2)}`,
        actorUserId: updated.userId,
        metadata: { paymentId: String(updated._id), giftCardId: String(giftCard._id) },
      });
    }
  }

  if (updated.purpose === PAYMENT_PURPOSE.SUBSCRIPTION && updated.subscriptionId) {
    const subscription = await subscriptionsService.activateSubscription({
      subscriptionId: updated.subscriptionId,
      paymentId: updated._id,
    });
    if (subscription) {
      const plan = await getPlan(subscription.planId);
      // activateSubscription()'s findOneAndUpdate returns the PRE-update document (same
      // convention as everywhere else in this codebase) — build the notification from
      // the plan's own figures rather than the (now-stale) returned subscription fields.
      const validUntil = new Date(Date.now() + plan.periodDays * 86_400_000).toLocaleDateString();
      await createClientNotification({
        userId: updated.userId,
        type: 'admin_message',
        title: 'Subscription active',
        body: `Your subscription is active with ${plan.creditsPerPeriod} credits, valid until ${validUntil}.`,
        link: '/account/subscription',
      });
      await logActivity({
        type: 'subscription_activated',
        message: `Subscription activated for plan ${plan.name}`,
        actorUserId: updated.userId,
        metadata: { paymentId: String(updated._id), subscriptionId: String(updated.subscriptionId) },
      });
    }
  }
}

export async function handlePaymentFailed({ paymentId }) {
  await paymentsCollection().updateOne(
    { _id: new ObjectId(paymentId), status: PAYMENT_STATUS.PENDING },
    { $set: { status: PAYMENT_STATUS.FAILED, updatedAt: new Date() } }
  );
}

// §4.4 — refunds: admin-triggered, recorded against the original payment, appointment
// status updated accordingly. §6.1 — the floor check (can't refund more than remains)
// and the write happen as one atomic operation guarded on refundedAmountCents, so two
// concurrent refund clicks can't together exceed the paid amount.
export async function refundPayment({ paymentId, amountCents, reason, actor, yoco = defaultYoco }) {
  const payment = await getPayment(paymentId);
  if (![PAYMENT_STATUS.PAID, PAYMENT_STATUS.PARTIALLY_REFUNDED].includes(payment.status)) {
    throw badRequest('Only a paid payment can be refunded.');
  }

  const remaining = payment.amountCents - payment.refundedAmountCents;
  const refundAmount = amountCents ?? remaining;
  if (refundAmount <= 0 || refundAmount > remaining) {
    throw badRequest(`Refund amount must be between 1 and ${remaining} cents.`);
  }

  const yocoRefund = await yoco.createRefund({
    checkoutId: payment.yocoCheckoutId,
    amountCents: refundAmount,
    metadata: { paymentId: String(payment._id) },
    idempotencyKey: `${payment._id}-refund-${Date.now()}`,
  });

  const newRefundedTotal = payment.refundedAmountCents + refundAmount;
  const newStatus = newRefundedTotal >= payment.amountCents ? PAYMENT_STATUS.REFUNDED : PAYMENT_STATUS.PARTIALLY_REFUNDED;
  const refundEntry = {
    amountCents: refundAmount,
    reason: reason ?? null,
    status: yocoRefund.status === 'succeeded' ? 'succeeded' : 'pending',
    yocoRefundId: yocoRefund.refundId ?? null,
    refundedBy: new ObjectId(actor._id),
    createdAt: new Date(),
  };

  // Optimistic-lock guard: only applies if refundedAmountCents still matches what we
  // just read — if another refund landed in between, this no-ops and we surface a 409
  // rather than silently over-refunding.
  const result = await paymentsCollection().findOneAndUpdate(
    { _id: payment._id, refundedAmountCents: payment.refundedAmountCents },
    {
      $set: { status: newStatus, refundedAmountCents: newRefundedTotal, updatedAt: new Date() },
      $push: { refunds: refundEntry },
    }
  );
  if (!result) {
    throw conflict('This payment was just refunded by another request. Please check its current status and retry.');
  }

  if (newStatus === PAYMENT_STATUS.REFUNDED && payment.appointmentId) {
    await appointmentsCollection().updateOne(
      {
        _id: payment.appointmentId,
        status: { $in: [APPOINTMENT_STATUS.PENDING_PAYMENT, APPOINTMENT_STATUS.CONFIRMED] },
      },
      {
        $set: {
          status: APPOINTMENT_STATUS.CANCELLED,
          cancelledAt: new Date(),
          cancelReason: 'Deposit refunded',
          updatedAt: new Date(),
        },
      }
    );
  }

  await logActivity({
    type: 'refund_issued',
    message: `Refund of R${(refundAmount / 100).toFixed(2)} issued for payment ${payment._id}${reason ? ` (${reason})` : ''}`,
    actorUserId: actor._id,
    metadata: { paymentId: String(payment._id) },
  });

  return getPayment(payment._id);
}

export class WebhookVerificationError extends AppError {
  constructor() {
    super('Invalid webhook signature.', 401, 'INVALID_WEBHOOK_SIGNATURE');
  }
}
