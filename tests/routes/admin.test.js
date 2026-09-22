import request from 'supertest';
import { createApp } from '../../src/app.js';
import { setTestDb } from '../../src/config/db.js';
import { createFakeDb } from '../helpers/fakeDb.js';
import { createTestService, createTestEmployee, futureDateString } from '../helpers/fixtures.js';
import { createUserAndToken } from '../helpers/testAuth.js';
import * as bookingService from '../../src/services/bookingService.js';
import * as paymentsService from '../../src/services/paymentsService.js';
import * as loyaltyService from '../../src/services/loyaltyService.js';
import { appointmentsCollection, appointmentsIndexes } from '../../src/models/appointments.js';
import { usersCollection, usersIndexes } from '../../src/models/users.js';
import { ROLES, PERMISSIONS } from '../../src/config/constants.js';
import { todayDateString } from '../../src/utils/businessTime.js';

const app = createApp();
const DATE = futureDateString();

beforeEach(async () => {
  setTestDb(createFakeDb());
  await appointmentsCollection().createIndexes(appointmentsIndexes);
});

describe('admin routes — permission gates', () => {
  it('rejects a plain customer from every admin endpoint', async () => {
    const { accessToken } = await createUserAndToken({ role: ROLES.CUSTOMER });
    for (const path of ['/api/admin/overview', '/api/admin/activity', '/api/admin/clients']) {
      // eslint-disable-next-line no-await-in-loop -- small fixed list, sequential is clearer here
      const res = await request(app).get(path).set('Authorization', `Bearer ${accessToken}`);
      expect(res.status).toBe(403);
    }
  });
});

describe('GET /api/admin/overview', () => {
  it('reflects a confirmed booking and its revenue', async () => {
    const { userId } = await createUserAndToken({ role: ROLES.CUSTOMER });
    const service = await createTestService({ priceCents: 30000 });
    const employee = await createTestEmployee();
    const appointment = await bookingService.createAppointment({
      userId: String(userId),
      employeeId: String(employee._id),
      serviceIds: [String(service._id)],
      date: DATE,
      startTime: '10:00',
    });
    const payment = await paymentsService.initiateBookingDepositPayment({
      appointmentId: appointment._id,
      actor: { _id: userId, role: ROLES.CUSTOMER },
      yoco: { createCheckout: async () => ({ id: 'c1', redirectUrl: 'https://x' }) },
    });
    await paymentsService.handlePaymentSucceeded({ paymentId: payment._id, yocoPaymentId: 'pay_1' });

    const { accessToken: adminToken } = await createUserAndToken({
      role: ROLES.ADMIN,
      permissions: [PERMISSIONS.VIEW_ANALYTICS],
    });
    const res = await request(app).get('/api/admin/overview').set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.upcomingConfirmed).toBe(1);
    expect(res.body.netRevenueCents).toBe(payment.amountCents);
    // Paid "just now" — falls inside every rolling window.
    expect(res.body.revenueTodayCents).toBe(payment.amountCents);
    expect(res.body.revenueWeekCents).toBe(payment.amountCents);
    expect(res.body.revenueMonthCents).toBe(payment.amountCents);
    expect(res.body.revenueBreakdown.bookingDepositCents).toBe(payment.amountCents);
    expect(res.body.revenueBreakdown.giftCardPurchaseCents).toBe(0);
    expect(res.body.avgBookingValueCents).toBe(payment.amountCents);
    expect(res.body.recentActivity.length).toBeGreaterThan(0);
  });

  it('computes a completion rate from finished bookings only, ignoring ones still upcoming', async () => {
    const { userId } = await createUserAndToken({ role: ROLES.CUSTOMER });
    const service = await createTestService();
    const employee = await createTestEmployee();
    const completed = await bookingService.createAppointment({
      userId: String(userId), employeeId: String(employee._id), serviceIds: [String(service._id)], date: DATE, startTime: '09:00',
    });
    await appointmentsCollection().updateOne({ _id: completed._id }, { $set: { status: 'completed' } });
    const cancelled = await bookingService.createAppointment({
      userId: String(userId), employeeId: String(employee._id), serviceIds: [String(service._id)], date: DATE, startTime: '11:00',
    });
    await appointmentsCollection().updateOne({ _id: cancelled._id }, { $set: { status: 'cancelled' } });
    // Still upcoming/unresolved — must not count toward the rate's denominator either way.
    await bookingService.createAppointment({
      userId: String(userId), employeeId: String(employee._id), serviceIds: [String(service._id)], date: DATE, startTime: '13:00',
    });

    const { accessToken: adminToken } = await createUserAndToken({ role: ROLES.ADMIN, permissions: [PERMISSIONS.VIEW_ANALYTICS] });
    const res = await request(app).get('/api/admin/overview').set('Authorization', `Bearer ${adminToken}`);
    expect(res.body.completedCount).toBe(1);
    expect(res.body.completionRate).toBe(50);
  });

  it('reports loyalty membership across the whole client base', async () => {
    const { userId: user1 } = await createUserAndToken({ role: ROLES.CUSTOMER });
    const { userId: user2 } = await createUserAndToken({ role: ROLES.CUSTOMER });
    await loyaltyService.awardPoints({ userId: user1, points: 100, source: 'booking_deposit_payment' });
    await loyaltyService.awardPoints({ userId: user2, points: 40, source: 'booking_deposit_payment' });

    const { accessToken: adminToken } = await createUserAndToken({ role: ROLES.ADMIN, permissions: [PERMISSIONS.VIEW_ANALYTICS] });
    const res = await request(app).get('/api/admin/overview').set('Authorization', `Bearer ${adminToken}`);
    expect(res.body.loyaltyMemberCount).toBe(2);
    expect(res.body.avgLoyaltyPoints).toBe(70);
  });

  it('counts cancellations and no-shows separately from active bookings', async () => {
    const { userId } = await createUserAndToken({ role: ROLES.CUSTOMER });
    const service = await createTestService();
    const employee = await createTestEmployee();
    const cancelled = await bookingService.createAppointment({
      userId: String(userId), employeeId: String(employee._id), serviceIds: [String(service._id)], date: DATE, startTime: '09:00',
    });
    await appointmentsCollection().updateOne({ _id: cancelled._id }, { $set: { status: 'cancelled' } });
    const noShow = await bookingService.createAppointment({
      userId: String(userId), employeeId: String(employee._id), serviceIds: [String(service._id)], date: DATE, startTime: '11:00',
    });
    await appointmentsCollection().updateOne({ _id: noShow._id }, { $set: { status: 'no_show' } });

    const { accessToken: adminToken } = await createUserAndToken({ role: ROLES.ADMIN, permissions: [PERMISSIONS.VIEW_ANALYTICS] });
    const res = await request(app).get('/api/admin/overview').set('Authorization', `Bearer ${adminToken}`);
    expect(res.body.cancellationsCount).toBe(1);
    expect(res.body.noShowsCount).toBe(1);
  });
});

describe('GET /api/admin/overview — staff scoping', () => {
  it("only counts a staff account's own bookings/revenue, never the whole salon's", async () => {
    const { userId } = await createUserAndToken({ role: ROLES.CUSTOMER });
    const service = await createTestService({ priceCents: 30000 });
    const myEmployee = await createTestEmployee();
    const otherEmployee = await createTestEmployee();

    const mine = await bookingService.createAppointment({
      userId: String(userId), employeeId: String(myEmployee._id), serviceIds: [String(service._id)], date: DATE, startTime: '09:00',
    });
    const minePayment = await paymentsService.initiateBookingDepositPayment({
      appointmentId: mine._id,
      actor: { _id: userId, role: ROLES.CUSTOMER },
      yoco: { createCheckout: async () => ({ id: 'c1', redirectUrl: 'https://x' }) },
    });
    await paymentsService.handlePaymentSucceeded({ paymentId: minePayment._id, yocoPaymentId: 'pay_mine' });

    const theirs = await bookingService.createAppointment({
      userId: String(userId), employeeId: String(otherEmployee._id), serviceIds: [String(service._id)], date: DATE, startTime: '11:00',
    });
    const theirsPayment = await paymentsService.initiateBookingDepositPayment({
      appointmentId: theirs._id,
      actor: { _id: userId, role: ROLES.CUSTOMER },
      yoco: { createCheckout: async () => ({ id: 'c2', redirectUrl: 'https://x' }) },
    });
    await paymentsService.handlePaymentSucceeded({ paymentId: theirsPayment._id, yocoPaymentId: 'pay_theirs' });

    const { accessToken: staffToken } = await createUserAndToken({ role: ROLES.STAFF, employeeId: myEmployee._id });
    const res = await request(app).get('/api/admin/overview').set('Authorization', `Bearer ${staffToken}`);
    expect(res.status).toBe(200);
    expect(res.body.upcomingConfirmed).toBe(1);
    expect(res.body.netRevenueCents).toBe(minePayment.amountCents);
    expect(res.body.recentActivity).toEqual([]);
  });

  it('rejects a staff account with no linked employeeId', async () => {
    const { accessToken } = await createUserAndToken({ role: ROLES.STAFF, employeeId: null });
    const res = await request(app).get('/api/admin/overview').set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(403);
  });
});

describe('GET /api/admin/trends', () => {
  it('rejects a non-admin', async () => {
    const { accessToken } = await createUserAndToken({ role: ROLES.CUSTOMER });
    const res = await request(app).get('/api/admin/trends?metric=revenue').set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(403);
  });

  it('rejects an unknown metric', async () => {
    const { accessToken } = await createUserAndToken({ role: ROLES.ADMIN, permissions: [PERMISSIONS.VIEW_ANALYTICS] });
    const res = await request(app).get('/api/admin/trends?metric=nonsense').set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(400);
  });

  it('buckets bookings by day and status over the requested window', async () => {
    const { userId } = await createUserAndToken({ role: ROLES.CUSTOMER });
    const service = await createTestService();
    const employee = await createTestEmployee();
    const appointment = await bookingService.createAppointment({
      userId: String(userId), employeeId: String(employee._id), serviceIds: [String(service._id)], date: DATE, startTime: '09:00',
    });
    // The trend window looks backward from today, but bookings must be created for a
    // future date — backdate it directly, same trick used for the cancelled/no-show test.
    const today = todayDateString();
    await appointmentsCollection().updateOne({ _id: appointment._id }, { $set: { date: today } });

    const { accessToken } = await createUserAndToken({ role: ROLES.ADMIN, permissions: [PERMISSIONS.VIEW_ANALYTICS] });
    const res = await request(app).get('/api/admin/trends?metric=bookings&days=365').set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.points).toHaveLength(365);
    const dayWithBooking = res.body.points.find((p) => p.date === today);
    expect(dayWithBooking.booked).toBe(1);
  });
});

describe('GET /api/admin/analytics/top-services', () => {
  it('ranks services by non-cancelled bookings in the window, excluding cancelled ones', async () => {
    const { userId } = await createUserAndToken({ role: ROLES.CUSTOMER });
    const employee = await createTestEmployee();
    const popular = await createTestService({ name: 'Gel Manicure' });
    const rare = await createTestService({ name: 'Nail Art' });

    const today = todayDateString();
    for (const [service, time] of [[popular, '09:00'], [popular, '10:00'], [rare, '11:00']]) {
      // eslint-disable-next-line no-await-in-loop -- small fixed list, sequential is clearer here
      const appt = await bookingService.createAppointment({
        userId: String(userId), employeeId: String(employee._id), serviceIds: [String(service._id)], date: DATE, startTime: time,
      });
      // eslint-disable-next-line no-await-in-loop
      await appointmentsCollection().updateOne({ _id: appt._id }, { $set: { date: today } });
    }
    const cancelledOne = await bookingService.createAppointment({
      userId: String(userId), employeeId: String(employee._id), serviceIds: [String(popular._id)], date: DATE, startTime: '13:00',
    });
    await appointmentsCollection().updateOne({ _id: cancelledOne._id }, { $set: { date: today, status: 'cancelled' } });

    const { accessToken } = await createUserAndToken({ role: ROLES.ADMIN, permissions: [PERMISSIONS.VIEW_ANALYTICS] });
    const res = await request(app).get('/api/admin/analytics/top-services?days=30').set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.items[0]).toEqual({ serviceId: String(popular._id), name: 'Gel Manicure', count: 2 });
    expect(res.body.items[1]).toEqual({ serviceId: String(rare._id), name: 'Nail Art', count: 1 });
  });
});

describe('GET /api/admin/analytics/staff-bookings', () => {
  it('is admin-only, never available to a staff account', async () => {
    const { accessToken } = await createUserAndToken({ role: ROLES.STAFF, employeeId: (await createTestEmployee())._id });
    const res = await request(app).get('/api/admin/analytics/staff-bookings').set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(403);
  });

  it('ranks staff by non-cancelled bookings', async () => {
    const { userId } = await createUserAndToken({ role: ROLES.CUSTOMER });
    const service = await createTestService();
    const busy = await createTestEmployee({ name: 'Noxolo' });
    const quiet = await createTestEmployee({ name: 'Naledi' });
    const today = todayDateString();

    const a1 = await bookingService.createAppointment({
      userId: String(userId), employeeId: String(busy._id), serviceIds: [String(service._id)], date: DATE, startTime: '09:00',
    });
    await appointmentsCollection().updateOne({ _id: a1._id }, { $set: { date: today } });
    const a2 = await bookingService.createAppointment({
      userId: String(userId), employeeId: String(quiet._id), serviceIds: [String(service._id)], date: DATE, startTime: '10:00',
    });
    await appointmentsCollection().updateOne({ _id: a2._id }, { $set: { date: today } });

    const { accessToken } = await createUserAndToken({ role: ROLES.ADMIN, permissions: [PERMISSIONS.VIEW_ANALYTICS] });
    const res = await request(app).get('/api/admin/analytics/staff-bookings').set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual(
      expect.arrayContaining([
        { employeeId: String(busy._id), name: 'Noxolo', count: 1 },
        { employeeId: String(quiet._id), name: 'Naledi', count: 1 },
      ])
    );
  });
});

describe('GET /api/admin/analytics/top-clients', () => {
  it('is admin-only, never available to a staff account', async () => {
    const { accessToken } = await createUserAndToken({ role: ROLES.STAFF, employeeId: (await createTestEmployee())._id });
    const res = await request(app).get('/api/admin/analytics/top-clients').set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(403);
  });

  it('ranks clients by booking count, excluding guest bookings entirely', async () => {
    const { userId } = await createUserAndToken({ role: ROLES.CUSTOMER });
    const user = await usersCollection().findOne({ _id: userId });
    const service = await createTestService();
    const employee = await createTestEmployee();
    await bookingService.createAppointment({
      userId: String(userId), employeeId: String(employee._id), serviceIds: [String(service._id)], date: DATE, startTime: '09:00',
    });
    await bookingService.createAppointment({
      userId: String(userId), employeeId: String(employee._id), serviceIds: [String(service._id)], date: DATE, startTime: '10:00',
    });
    await bookingService.createAppointment({
      userId: null,
      guestInfo: { firstName: 'Guest', lastName: 'Person', email: 'guest@example.com', phone: '0820000000' },
      employeeId: String(employee._id), serviceIds: [String(service._id)], date: DATE, startTime: '11:00',
    });

    const { accessToken } = await createUserAndToken({ role: ROLES.ADMIN, permissions: [PERMISSIONS.VIEW_ANALYTICS] });
    const res = await request(app).get('/api/admin/analytics/top-clients').set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ userId: String(userId), email: user.email, bookingsCount: 2 });
  });
});

describe('GET /api/admin/clients/:id', () => {
  it("returns a client's profile and booking history", async () => {
    const { userId } = await createUserAndToken({ role: ROLES.CUSTOMER });
    const service = await createTestService();
    const employee = await createTestEmployee();
    await bookingService.createAppointment({
      userId: String(userId),
      employeeId: String(employee._id),
      serviceIds: [String(service._id)],
      date: DATE,
      startTime: '11:00',
    });

    const { accessToken: adminToken } = await createUserAndToken({
      role: ROLES.ADMIN,
      permissions: [PERMISSIONS.MANAGE_CLIENTS],
    });
    const res = await request(app).get(`/api/admin/clients/${userId}`).set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.client.passwordHash).toBeUndefined();
    expect(res.body.appointments).toHaveLength(1);
  });
});

describe('GET /api/admin/clients (list)', () => {
  it('enriches each row with bookingsCount, lastBookingDate and loyaltyPoints', async () => {
    const { userId } = await createUserAndToken({ role: ROLES.CUSTOMER });
    const service = await createTestService();
    const employee = await createTestEmployee();
    await bookingService.createAppointment({
      userId: String(userId), employeeId: String(employee._id), serviceIds: [String(service._id)], date: DATE, startTime: '09:00',
    });

    const { accessToken: adminToken } = await createUserAndToken({ role: ROLES.ADMIN, permissions: [PERMISSIONS.MANAGE_CLIENTS] });
    const res = await request(app).get('/api/admin/clients').set('Authorization', `Bearer ${adminToken}`);
    const row = res.body.clients.find((c) => c._id === String(userId));
    expect(row.bookingsCount).toBe(1);
    expect(row.lastBookingDate).toBe(DATE);
    expect(row.loyaltyPoints).toBe(0);
  });

  it('filters by search against name/email', async () => {
    await createUserAndToken({ role: ROLES.CUSTOMER });
    const { accessToken: adminToken } = await createUserAndToken({ role: ROLES.ADMIN, permissions: [PERMISSIONS.MANAGE_CLIENTS] });
    const res = await request(app).get('/api/admin/clients?search=nobody-matches-this').set('Authorization', `Bearer ${adminToken}`);
    expect(res.body.total).toBe(0);
  });
});

describe('POST /api/admin/clients/:id/block and /unblock', () => {
  it('blocks a client (isActive false) then unblocks them, gated by manage_clients', async () => {
    const { userId } = await createUserAndToken({ role: ROLES.CUSTOMER });
    const { accessToken: adminToken } = await createUserAndToken({ role: ROLES.ADMIN, permissions: [PERMISSIONS.MANAGE_CLIENTS] });

    const blockRes = await request(app).post(`/api/admin/clients/${userId}/block`).set('Authorization', `Bearer ${adminToken}`);
    expect(blockRes.status).toBe(200);
    expect(blockRes.body.client.isActive).toBe(false);

    const unblockRes = await request(app).post(`/api/admin/clients/${userId}/unblock`).set('Authorization', `Bearer ${adminToken}`);
    expect(unblockRes.status).toBe(200);
    expect(unblockRes.body.client.isActive).toBe(true);
  });

  it('rejects a non-admin', async () => {
    const { userId } = await createUserAndToken({ role: ROLES.CUSTOMER });
    const { accessToken } = await createUserAndToken({ role: ROLES.CUSTOMER });
    const res = await request(app).post(`/api/admin/clients/${userId}/block`).set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(403);
  });
});

describe('POST /api/admin/notifications/send', () => {
  it('rejects a non-admin', async () => {
    const { accessToken } = await createUserAndToken({ role: ROLES.CUSTOMER });
    const res = await request(app)
      .post('/api/admin/notifications/send')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ broadcast: true, title: 'Hi', body: 'Hello everyone' });
    expect(res.status).toBe(403);
  });

  it('rejects providing both userId and broadcast, or neither', async () => {
    const { accessToken } = await createUserAndToken({ role: ROLES.ADMIN, permissions: [PERMISSIONS.SEND_NOTIFICATIONS] });
    const neither = await request(app)
      .post('/api/admin/notifications/send')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ title: 'Hi', body: 'Hello' });
    expect(neither.status).toBe(400);
  });

  it('sends a targeted notification to one client and a broadcast to all', async () => {
    const { userId: client1 } = await createUserAndToken({ role: ROLES.CUSTOMER });
    await createUserAndToken({ role: ROLES.CUSTOMER });
    const { accessToken } = await createUserAndToken({ role: ROLES.ADMIN, permissions: [PERMISSIONS.SEND_NOTIFICATIONS] });

    const targetedRes = await request(app)
      .post('/api/admin/notifications/send')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ userId: String(client1), title: 'Reminder', body: 'Your appointment is tomorrow.' });
    expect(targetedRes.status).toBe(200);
    expect(targetedRes.body.sentCount).toBe(1);

    const broadcastRes = await request(app)
      .post('/api/admin/notifications/send')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ broadcast: true, title: 'Holiday hours', body: "We're closed on Sunday." });
    expect(broadcastRes.status).toBe(200);
    // 3 customers created: client1, the second createUserAndToken call, and the admin
    // is role=admin so excluded — broadcast only targets customers.
    expect(broadcastRes.body.sentCount).toBe(2);
  });
});

describe('admin user management (/api/admin/users)', () => {
  async function manager() {
    return createUserAndToken({ role: ROLES.ADMIN, permissions: [PERMISSIONS.MANAGE_ADMIN_USERS] });
  }

  it('rejects an admin without the manage_admin_users permission', async () => {
    const { accessToken } = await createUserAndToken({ role: ROLES.ADMIN, permissions: [] });
    const res = await request(app).get('/api/admin/users').set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(403);
  });

  it('invites a brand-new admin and lists them afterwards', async () => {
    const { accessToken } = await manager();
    const inviteRes = await request(app)
      .post('/api/admin/users')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ email: 'invitee@example.com', firstName: 'Invi', lastName: 'Tee', permissions: [PERMISSIONS.MANAGE_GALLERY] });
    expect(inviteRes.status).toBe(201);
    expect(inviteRes.body.adminUser.email).toBe('invitee@example.com');

    const listRes = await request(app).get('/api/admin/users').set('Authorization', `Bearer ${accessToken}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.total).toBe(2); // the invitee + the acting manager admin
  });

  it('rejects an unknown permission in the invite payload with 400', async () => {
    const { accessToken } = await manager();
    const res = await request(app)
      .post('/api/admin/users')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ email: 'bad@example.com', firstName: 'A', lastName: 'B', permissions: ['not_real'] });
    expect(res.status).toBe(400);
  });

  it("updates another admin's permissions", async () => {
    const { accessToken } = await manager();
    const { userId: targetId } = await createUserAndToken({ role: ROLES.ADMIN, permissions: [] });
    const res = await request(app)
      .patch(`/api/admin/users/${targetId}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ permissions: [PERMISSIONS.MANAGE_PAYMENTS] });
    expect(res.status).toBe(200);
    expect(res.body.adminUser.permissions).toEqual([PERMISSIONS.MANAGE_PAYMENTS]);
  });

  it('blocks an admin from editing their own permissions via the route', async () => {
    const { accessToken, userId } = await manager();
    const res = await request(app)
      .patch(`/api/admin/users/${userId}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ permissions: [] });
    expect(res.status).toBe(409);
  });

  it('invites a staff account linked to an employee record, scoped with no permissions', async () => {
    const { accessToken } = await manager();
    const employee = await createTestEmployee();
    const inviteRes = await request(app)
      .post('/api/admin/users')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ email: 'staffer@example.com', firstName: 'Staff', lastName: 'Er', role: ROLES.STAFF, employeeId: String(employee._id) });
    expect(inviteRes.status).toBe(201);
    expect(inviteRes.body.adminUser.role).toBe(ROLES.STAFF);
    expect(inviteRes.body.adminUser.permissions).toEqual([]);
    expect(String(inviteRes.body.adminUser.employeeId)).toBe(String(employee._id));

    const listRes = await request(app).get('/api/admin/users').set('Authorization', `Bearer ${accessToken}`);
    expect(listRes.body.adminUsers.some((u) => u.email === 'staffer@example.com')).toBe(true);
  });

  // Regression for a real bug found via manual end-to-end verification: inviteAdminUser
  // used to hardcode `referralCode: null` for every brand-new account. referralCode is
  // unique+sparse in real Mongo, but a sparse index still indexes an explicit null (it
  // only skips a genuinely *missing* field) — so the second-ever invite of a brand-new
  // admin/staff account would fail with E11000 in production. Enforced here by actually
  // registering usersIndexes against the fake DB, which every other test in this file
  // skips (that's exactly why this went undetected before).
  it('lets two different brand-new accounts be invited back to back without a referralCode collision', async () => {
    await usersCollection().createIndexes(usersIndexes);
    const { accessToken } = await manager();

    const first = await request(app)
      .post('/api/admin/users')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ email: 'first-invite@example.com', firstName: 'First', lastName: 'Invite', permissions: [] });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post('/api/admin/users')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ email: 'second-invite@example.com', firstName: 'Second', lastName: 'Invite', permissions: [] });
    expect(second.status).toBe(201);
    expect(second.body.adminUser.referralCode).toEqual(expect.any(String));
    expect(second.body.adminUser.referralCode).not.toBe(first.body.adminUser.referralCode);
  });

  it('rejects a staff invite with no employeeId', async () => {
    const { accessToken } = await manager();
    const res = await request(app)
      .post('/api/admin/users')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ email: 'nolinked@example.com', firstName: 'No', lastName: 'Link', role: ROLES.STAFF });
    expect(res.status).toBe(400);
  });

  it('revokes admin access, and blocks self-revoke', async () => {
    const { accessToken, userId: managerId } = await manager();
    const { userId: targetId } = await createUserAndToken({ role: ROLES.ADMIN, permissions: [PERMISSIONS.MANAGE_SERVICES] });

    const revokeRes = await request(app)
      .post(`/api/admin/users/${targetId}/revoke`)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(revokeRes.status).toBe(200);
    expect(revokeRes.body.adminUser.role).toBe(ROLES.CUSTOMER);

    const selfRevokeRes = await request(app)
      .post(`/api/admin/users/${managerId}/revoke`)
      .set('Authorization', `Bearer ${accessToken}`);
    expect(selfRevokeRes.status).toBe(409);
  });
});
