import request from 'supertest';
import { createApp } from '../../src/app.js';
import { setTestDb } from '../../src/config/db.js';
import { createFakeDb } from '../helpers/fakeDb.js';
import { createTestService, createTestEmployee, futureDateString } from '../helpers/fixtures.js';
import { createUserAndToken } from '../helpers/testAuth.js';
import { appointmentsCollection, appointmentsIndexes } from '../../src/models/appointments.js';
import { ROLES, PERMISSIONS } from '../../src/config/constants.js';

const app = createApp();
const DATE = futureDateString();

beforeEach(async () => {
  setTestDb(createFakeDb());
  await appointmentsCollection().createIndexes(appointmentsIndexes);
});

describe('POST /api/appointments', () => {
  it('lets a guest book without an account', async () => {
    const service = await createTestService();
    const employee = await createTestEmployee();
    const res = await request(app)
      .post('/api/appointments')
      .send({
        serviceIds: [String(service._id)],
        date: DATE,
        startTime: '10:00',
        employeeId: String(employee._id),
        guestInfo: { name: 'Guest', email: 'guest@example.com', phone: '0821234567' },
      });
    expect(res.status).toBe(201);
    expect(res.body.appointment.userId).toBeNull();
  });

  it('rejects a request with neither a login nor guest info', async () => {
    const service = await createTestService();
    const res = await request(app)
      .post('/api/appointments')
      .send({ serviceIds: [String(service._id)], date: DATE, startTime: '10:00' });
    expect(res.status).toBe(403);
  });

  it('rejects a public guest booking once an admin turns off guest checkout', async () => {
    const { accessToken: adminToken } = await createUserAndToken({
      role: ROLES.ADMIN,
      permissions: [PERMISSIONS.MANAGE_SETTINGS],
    });
    await request(app)
      .patch('/api/settings')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ allowGuestBooking: false });

    const service = await createTestService();
    const employee = await createTestEmployee();
    const res = await request(app)
      .post('/api/appointments')
      .send({
        serviceIds: [String(service._id)],
        date: DATE,
        startTime: '10:00',
        employeeId: String(employee._id),
        guestInfo: { name: 'Guest', email: 'guest@example.com', phone: '0821234567' },
      });
    expect(res.status).toBe(403);

    // A logged-in customer is unaffected — only the public guest path is gated.
    const { accessToken: customerToken } = await createUserAndToken({ role: ROLES.CUSTOMER });
    const asCustomer = await request(app)
      .post('/api/appointments')
      .set('Authorization', `Bearer ${customerToken}`)
      .send({ serviceIds: [String(service._id)], date: DATE, startTime: '10:00', employeeId: String(employee._id) });
    expect(asCustomer.status).toBe(201);

    // An admin creating a guest (walk-in/phone) booking on a client's behalf is also unaffected.
    const asAdmin = await request(app)
      .post('/api/appointments')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        serviceIds: [String(service._id)],
        date: DATE,
        startTime: '11:00',
        employeeId: String(employee._id),
        guestInfo: { name: 'Phone Client', email: 'phone-client@example.com', phone: '0821234567' },
      });
    expect(asAdmin.status).toBe(201);
  });

  it('never trusts a client-submitted price — only serviceIds/date/time are accepted', async () => {
    const service = await createTestService({ priceCents: 30000 });
    const employee = await createTestEmployee();
    const { accessToken } = await createUserAndToken({ role: ROLES.CUSTOMER });
    const res = await request(app)
      .post('/api/appointments')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        serviceIds: [String(service._id)],
        date: DATE,
        startTime: '10:00',
        employeeId: String(employee._id),
        totalPriceCents: 1, // must be ignored/stripped
        paymentStatus: 'paid', // must be ignored/stripped
      });
    expect(res.status).toBe(201);
    expect(res.body.appointment.totalPriceCents).toBe(30000);
    expect(res.body.appointment.status).toBe('pending_payment');
  });

  it('lets an admin book on behalf of an existing customer', async () => {
    const service = await createTestService();
    const employee = await createTestEmployee();
    const { accessToken: adminToken } = await createUserAndToken({
      role: ROLES.ADMIN,
      permissions: [PERMISSIONS.MANAGE_APPOINTMENTS],
    });
    const { userId: customerId } = await createUserAndToken({ role: ROLES.CUSTOMER });

    const res = await request(app)
      .post('/api/appointments')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        serviceIds: [String(service._id)],
        date: DATE,
        startTime: '10:00',
        employeeId: String(employee._id),
        onBehalfOfUserId: String(customerId),
      });
    expect(res.status).toBe(201);
    expect(res.body.appointment.userId).toBe(String(customerId));
  });
});

describe('GET /api/appointments/:id — IDOR protection', () => {
  it("rejects a customer reading another customer's appointment", async () => {
    const service = await createTestService();
    const employee = await createTestEmployee();
    const { accessToken: ownerToken } = await createUserAndToken({ role: ROLES.CUSTOMER });
    const { accessToken: strangerToken } = await createUserAndToken({ role: ROLES.CUSTOMER });

    const createRes = await request(app)
      .post('/api/appointments')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ serviceIds: [String(service._id)], date: DATE, startTime: '10:00', employeeId: String(employee._id) });
    const id = createRes.body.appointment._id;

    const strangerRes = await request(app).get(`/api/appointments/${id}`).set('Authorization', `Bearer ${strangerToken}`);
    expect(strangerRes.status).toBe(403);

    const ownerRes = await request(app).get(`/api/appointments/${id}`).set('Authorization', `Bearer ${ownerToken}`);
    expect(ownerRes.status).toBe(200);
  });
});

describe('GET /api/appointments (admin list)', () => {
  it('rejects a customer and allows an admin with manage_appointments', async () => {
    const { accessToken: customerToken } = await createUserAndToken({ role: ROLES.CUSTOMER });
    const { accessToken: adminToken } = await createUserAndToken({
      role: ROLES.ADMIN,
      permissions: [PERMISSIONS.MANAGE_APPOINTMENTS],
    });

    const customerRes = await request(app).get('/api/appointments').set('Authorization', `Bearer ${customerToken}`);
    expect(customerRes.status).toBe(403);

    const adminRes = await request(app).get('/api/appointments').set('Authorization', `Bearer ${adminToken}`);
    expect(adminRes.status).toBe(200);
    expect(adminRes.body).toHaveProperty('total');
  });

  it('filters by serviceId', async () => {
    const serviceA = await createTestService({ name: 'A' });
    const serviceB = await createTestService({ name: 'B' });
    const employee = await createTestEmployee();
    const { accessToken } = await createUserAndToken({ role: ROLES.CUSTOMER });
    await request(app).post('/api/appointments').set('Authorization', `Bearer ${accessToken}`).send({
      serviceIds: [String(serviceA._id)], date: DATE, startTime: '09:00', employeeId: String(employee._id),
    });
    await request(app).post('/api/appointments').set('Authorization', `Bearer ${accessToken}`).send({
      serviceIds: [String(serviceB._id)], date: DATE, startTime: '11:00', employeeId: String(employee._id),
    });

    const { accessToken: adminToken } = await createUserAndToken({ role: ROLES.ADMIN, permissions: [PERMISSIONS.MANAGE_APPOINTMENTS] });
    const res = await request(app)
      .get(`/api/appointments?serviceId=${serviceA._id}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.body.total).toBe(1);
    expect(res.body.appointments[0].serviceIds).toContain(String(serviceA._id));
  });

  it('filters by clientSearch against a guest name/email or a logged-in user', async () => {
    const service = await createTestService();
    const employee = await createTestEmployee();
    await request(app).post('/api/appointments').send({
      serviceIds: [String(service._id)], date: DATE, startTime: '09:00', employeeId: String(employee._id),
      guestInfo: { name: 'Zola Guest', email: 'zola@example.com', phone: '0821234567' },
    });
    const { accessToken } = await createUserAndToken({ role: ROLES.CUSTOMER });
    await request(app).post('/api/appointments').set('Authorization', `Bearer ${accessToken}`).send({
      serviceIds: [String(service._id)], date: DATE, startTime: '11:00', employeeId: String(employee._id),
    });

    const { accessToken: adminToken } = await createUserAndToken({ role: ROLES.ADMIN, permissions: [PERMISSIONS.MANAGE_APPOINTMENTS] });
    const res = await request(app)
      .get('/api/appointments?clientSearch=zola')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.body.total).toBe(1);
    expect(res.body.appointments[0].guestInfo.name).toBe('Zola Guest');
  });

  it('attaches a resolved clientName/clientEmail to every row, guest or logged-in', async () => {
    const service = await createTestService();
    const employee = await createTestEmployee();
    await request(app).post('/api/appointments').send({
      serviceIds: [String(service._id)], date: DATE, startTime: '09:00', employeeId: String(employee._id),
      guestInfo: { name: 'Guest Person', email: 'guest@example.com', phone: '0821234567' },
    });
    const { accessToken } = await createUserAndToken({ role: ROLES.CUSTOMER });
    await request(app).post('/api/appointments').set('Authorization', `Bearer ${accessToken}`).send({
      serviceIds: [String(service._id)], date: DATE, startTime: '11:00', employeeId: String(employee._id),
    });

    const { accessToken: adminToken } = await createUserAndToken({ role: ROLES.ADMIN, permissions: [PERMISSIONS.MANAGE_APPOINTMENTS] });
    const res = await request(app).get('/api/appointments').set('Authorization', `Bearer ${adminToken}`);
    const guestRow = res.body.appointments.find((a) => a.startTime === '09:00');
    const loggedInRow = res.body.appointments.find((a) => a.startTime === '11:00');
    expect(guestRow.clientName).toBe('Guest Person');
    expect(guestRow.clientEmail).toBe('guest@example.com');
    expect(loggedInRow.clientName).toEqual(expect.any(String));
    expect(loggedInRow.clientEmail).toEqual(expect.any(String));
  });

  it("a linked staff account only ever sees its own employeeId's rows, even if it asks for another", async () => {
    const service = await createTestService();
    const myEmployee = await createTestEmployee();
    const otherEmployee = await createTestEmployee();
    const { accessToken } = await createUserAndToken({ role: ROLES.CUSTOMER });
    await request(app).post('/api/appointments').set('Authorization', `Bearer ${accessToken}`).send({
      serviceIds: [String(service._id)], date: DATE, startTime: '09:00', employeeId: String(myEmployee._id),
    });
    await request(app).post('/api/appointments').set('Authorization', `Bearer ${accessToken}`).send({
      serviceIds: [String(service._id)], date: DATE, startTime: '11:00', employeeId: String(otherEmployee._id),
    });

    const { accessToken: staffToken } = await createUserAndToken({ role: ROLES.STAFF, employeeId: myEmployee._id });
    // Client-supplied employeeId query param must be ignored server-side, not just hidden client-side.
    const res = await request(app)
      .get(`/api/appointments?employeeId=${otherEmployee._id}`)
      .set('Authorization', `Bearer ${staffToken}`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.appointments[0].startTime).toBe('09:00');
  });

  it('rejects a staff account with no linked employeeId', async () => {
    const { accessToken } = await createUserAndToken({ role: ROLES.STAFF, employeeId: null });
    const res = await request(app).get('/api/appointments').set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(403);
  });
});

describe('GET /api/appointments/slots', () => {
  it('returns bookable start times for a service/date', async () => {
    const service = await createTestService({ durationMinutes: 60 });
    await createTestEmployee();
    const res = await request(app).get('/api/appointments/slots').query({ serviceIds: String(service._id), date: DATE });
    expect(res.status).toBe(200);
    expect(res.body.slots).toContain('10:00');
  });
});
