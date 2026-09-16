import request from 'supertest';
import { ObjectId } from 'mongodb';
import { createApp } from '../../src/app.js';
import { setTestDb } from '../../src/config/db.js';
import { createFakeDb } from '../helpers/fakeDb.js';
import { createTestService, createTestEmployee, futureDateString } from '../helpers/fixtures.js';
import { createUserAndToken } from '../helpers/testAuth.js';
import { signWebhookBody } from '../helpers/yocoWebhook.js';
import * as bookingService from '../../src/services/bookingService.js';
import * as paymentsService from '../../src/services/paymentsService.js';
import { appointmentsCollection, appointmentsIndexes } from '../../src/models/appointments.js';
import { ROLES, PERMISSIONS } from '../../src/config/constants.js';

// initiateBookingDepositPayment/refundPayment call the real Yoco API by default at the
// route layer (dependency-injected only in service-level tests) — so route tests here
// stick to paths that are rejected before any outbound call (auth/ownership/validation
// gates), plus the webhook endpoint, which is inbound-only and fully testable.
const app = createApp();
const DATE = futureDateString();

beforeEach(async () => {
  setTestDb(createFakeDb());
  await appointmentsCollection().createIndexes(appointmentsIndexes);
});

async function bookAppointment(userId) {
  const service = await createTestService({ priceCents: 30000 });
  const employee = await createTestEmployee();
  return bookingService.createAppointment({
    userId: String(userId),
    employeeId: String(employee._id),
    serviceIds: [String(service._id)],
    date: DATE,
    startTime: '10:00',
  });
}

describe('POST /api/payments/appointments/:appointmentId/checkout', () => {
  it("rejects a customer initiating payment for someone else's appointment", async () => {
    const { userId: owner } = await createUserAndToken({ role: ROLES.CUSTOMER });
    const { accessToken: strangerToken } = await createUserAndToken({ role: ROLES.CUSTOMER });
    const appointment = await bookAppointment(owner);

    const res = await request(app)
      .post(`/api/payments/appointments/${appointment._id}/checkout`)
      .set('Authorization', `Bearer ${strangerToken}`);
    expect(res.status).toBe(403);
  });

  it('rejects initiating payment for a non-existent appointment', async () => {
    const { accessToken } = await createUserAndToken({ role: ROLES.CUSTOMER });
    const res = await request(app)
      .post(`/api/payments/appointments/${new ObjectId()}/checkout`)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(404);
  });
});

describe('POST /api/payments/:id/refund', () => {
  it('rejects a non-admin', async () => {
    const { accessToken } = await createUserAndToken({ role: ROLES.CUSTOMER });
    const res = await request(app)
      .post(`/api/payments/${new ObjectId()}/refund`)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(403);
  });

  it('rejects a negative refund amount before touching the payment', async () => {
    const { accessToken } = await createUserAndToken({ role: ROLES.ADMIN, permissions: [PERMISSIONS.MANAGE_PAYMENTS] });
    const res = await request(app)
      .post(`/api/payments/${new ObjectId()}/refund`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ amountCents: -100 });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/payments/webhook', () => {
  it('rejects a request with an invalid signature', async () => {
    const rawBody = JSON.stringify({ type: 'payment.succeeded', payload: { id: 'pay_1', metadata: {} } });
    const res = await request(app)
      .post('/api/payments/webhook')
      .set('Content-Type', 'application/octet-stream')
      .set('webhook-id', 'msg_fake')
      .set('webhook-timestamp', String(Math.floor(Date.now() / 1000)))
      .set('webhook-signature', 'v1,not-a-real-signature')
      .send(Buffer.from(rawBody));
    expect(res.status).toBe(401);
  });

  it('confirms the appointment on a validly-signed payment.succeeded event, idempotently', async () => {
    const { userId } = await createUserAndToken({ role: ROLES.CUSTOMER });
    const appointment = await bookAppointment(userId);
    const payment = await paymentsService.initiateBookingDepositPayment({
      appointmentId: appointment._id,
      actor: { _id: userId, role: ROLES.CUSTOMER },
      yoco: { createCheckout: async () => ({ id: 'checkout_1', redirectUrl: 'https://c.yoco.com/x' }) },
    });

    const eventBody = {
      id: 'evt_1',
      type: 'payment.succeeded',
      createdDate: new Date().toISOString(),
      payload: { id: 'pay_abc', amount: payment.amountCents, currency: 'ZAR', status: 'succeeded', metadata: { paymentId: String(payment._id) } },
    };
    const { rawBody, headers } = signWebhookBody(eventBody);
    const bodyBuffer = Buffer.from(rawBody);

    // Content-Type is deliberately application/octet-stream, not application/json: the
    // route's express.raw({ type: '*/*' }) accepts any content type in production (Yoco
    // really does send application/json), but supertest/superagent JSON-serializes a
    // Buffer body — corrupting it — specifically when Content-Type is application/json.
    // octet-stream sidesteps that test-harness quirk while still exercising raw-body
    // signature verification byte-for-byte.
    const firstDelivery = await request(app)
      .post('/api/payments/webhook')
      .set('Content-Type', 'application/octet-stream')
      .set(headers)
      .send(bodyBuffer);
    expect(firstDelivery.status).toBe(200);

    const confirmed = await bookingService.getAppointment(appointment._id);
    expect(confirmed.status).toBe('confirmed');

    // Yoco redelivers the same event — must not error and must not double-process.
    const replay = await request(app)
      .post('/api/payments/webhook')
      .set('Content-Type', 'application/octet-stream')
      .set(headers)
      .send(bodyBuffer);
    expect(replay.status).toBe(200);
  });
});
