import { ObjectId } from 'mongodb';
import { paymentsCollection } from '../models/payments.js';
import { appointmentsCollection, DUPLICATE_KEY_ERROR_CODE } from '../models/appointments.js';
import { usersCollection } from '../models/users.js';
import * as defaultYoco from '../config/yocoClient.js';
import { createClientNotification } from './clientNotificationsService.js';
import { logActivity } from './activityLogService.js';
import { checkSlotBookable, cancelUnviableAppointment } from './bookingService.js';
import { awardPoints, previewRedemption, redeemPoints } from './loyaltyService.js';
import { completeReferralIfPending } from './referralService.js';
import { getSettings } from './settingsService.js';
import { validateDiscountCode, redeemDiscountCode } from './discountsService.js';
import * as giftCardsService from './giftCardsService.js';
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

  // Only a paid appointment holds its slot (bookingService.js's evaluateSlot) — this
  // pending appointment never blocked anyone else, so someone else may since have been
  // confirmed for the exact same slot. Re-check right before sending the customer to
  // Yoco rather than after: don't charge them for a booking that's already gone.
  const stillBookable = await checkSlotBookable({
    employeeId: appointment.employeeId,
    date: appointment.date,
    startTime: appointment.startTime,
    endTime: appointment.endTime,
    excludeAppointmentId: appointment._id,
  });
  if (!stillBookable.bookable) {
    await cancelUnviableAppointment(appointment, 'This slot was taken by another confirmed booking before payment was completed.');
    throw conflict('This slot was just taken by another booking. Please choose a different time.');
  }

  const existing = await paymentsCollection().findOne({
    appointmentId: appointment._id,
    status: PAYMENT_STATUS.PENDING,
  });
  if (existing) {
    // A real, reusable pending checkout always has a redirectUrl — reuse it as before.
    if (existing.redirectUrl) return existing;
    // Found via a real repro: a previous attempt got as far as reserving this payment
    // record but never got a real checkout back from Yoco (e.g. a transient Yoco error,
    // or the account's live keys rejecting a non-HTTPS CLIENT_URL locally) — reusing it
    // would hand the customer a null redirectUrl, and `window.location.href = null`
    // silently strands them on a 404 instead of ever letting them pay, with no way to
    // recover short of contacting support. Mark it failed and fall through to create a
    // fresh checkout instead.
    await paymentsCollection().updateOne(
      { _id: existing._id },
      { $set: { status: PAYMENT_STATUS.FAILED, updatedAt: new Date() } }
    );
  }

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

// §6.2 — one function, every caller that needs to run the "a booking deposit just got
// paid" side effects. `updated` is a payment already atomically transitioned to PAID by
// the caller; this only runs the appointment-confirmation side effects and is itself
// guarded by the appointment's own pending→confirmed transition, so it's safe even if
// somehow invoked twice.
async function confirmAppointmentForPaidDeposit(updated) {
  let appointment;
  try {
    appointment = await appointmentsCollection().findOneAndUpdate(
      { _id: updated.appointmentId, status: APPOINTMENT_STATUS.PENDING_PAYMENT },
      {
        $set: {
          status: APPOINTMENT_STATUS.CONFIRMED,
          paymentId: updated._id,
          autoExpireAt: null,
          updatedAt: new Date(),
        },
      }
    );
  } catch (err) {
    if (err.code !== DUPLICATE_KEY_ERROR_CODE) throw err;
    // Only a paid appointment holds its slot, so two customers can each be mid-checkout
    // for the same slot at once — the initiate-checkout guard re-checks availability
    // right before Yoco, but can't close the window between that check and the webhook
    // itself. This is that residual race: another booking was confirmed for the exact
    // same slot in between, and this update collided with the unique index. This
    // customer's payment DID succeed, so it can't just be dropped — cancel the now-
    // unviable appointment and flag the payment loudly for a manual refund.
    const current = await appointmentsCollection().findOne({ _id: updated.appointmentId });
    if (current) {
      await cancelUnviableAppointment(current, 'This slot was taken by another confirmed booking before this payment could be confirmed.');
    }
    await logActivity({
      type: 'payment_needs_review',
      message: `Payment of R${(updated.amountCents / 100).toFixed(2)} was received, but another booking had already been confirmed for the same slot by the time it processed. Needs manual refund.`,
      actorUserId: current?.userId ?? null,
      metadata: { paymentId: String(updated._id), appointmentId: String(updated.appointmentId) },
    });
    return;
  }
  if (!appointment) {
    // The initiate-checkout guard above should catch a slot that's already gone before
    // the customer ever reaches Yoco, but this webhook is the source of truth for "did
    // they pay" and can't be skipped — so if the appointment stopped being
    // pending_payment in the narrow window between checkout and this call (e.g. an admin
    // cancelled it), a real payment was captured for a slot that's no longer held.
    // Surface it for manual follow-up rather than silently dropping a paid-but-
    // unconfirmed booking.
    const current = await appointmentsCollection().findOne({ _id: updated.appointmentId });
    await logActivity({
      type: 'payment_needs_review',
      message: `Payment of R${(updated.amountCents / 100).toFixed(2)} was received, but its appointment is no longer awaiting payment (status: ${current?.status ?? 'unknown'}). Needs manual refund or rebooking.`,
      actorUserId: current?.userId ?? null,
      metadata: { paymentId: String(updated._id), appointmentId: String(updated.appointmentId) },
    });
    return;
  }

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
    // already applied at checkout — see initiateBookingDepositPayment).
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
