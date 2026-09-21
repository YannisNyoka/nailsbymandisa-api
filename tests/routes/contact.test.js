import request from 'supertest';
import { createApp } from '../../src/app.js';
import { setTestDb } from '../../src/config/db.js';
import { createFakeDb } from '../helpers/fakeDb.js';
import { createUserAndToken } from '../helpers/testAuth.js';
import { ROLES, PERMISSIONS } from '../../src/config/constants.js';

const app = createApp();

beforeEach(() => {
  setTestDb(createFakeDb());
});

async function adminToken() {
  const { accessToken } = await createUserAndToken({
    role: ROLES.ADMIN,
    permissions: [PERMISSIONS.MANAGE_ENQUIRIES],
  });
  return accessToken;
}

describe('POST /api/contact — public enquiry submission', () => {
  it('accepts a valid enquiry with no auth required', async () => {
    const res = await request(app)
      .post('/api/contact')
      .send({ name: 'Thandi', email: 'thandi@example.com', message: 'Do you do nail art?' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ ok: true });
  });

  it('accepts an enquiry with no name (optional)', async () => {
    const res = await request(app)
      .post('/api/contact')
      .send({ email: 'thandi@example.com', message: 'Do you do nail art?' });
    expect(res.status).toBe(201);
  });

  it('rejects a missing email or message with 400', async () => {
    const res = await request(app).post('/api/contact').send({ name: 'Thandi', message: 'Hi' });
    expect(res.status).toBe(400);
  });

  it('rejects an invalid email with 400', async () => {
    const res = await request(app)
      .post('/api/contact')
      .send({ email: 'not-an-email', message: 'Hi' });
    expect(res.status).toBe(400);
  });
});

describe('GET/PATCH /api/contact — admin enquiry inbox', () => {
  it('rejects listing without the manage_enquiries permission', async () => {
    const { accessToken } = await createUserAndToken({ role: ROLES.CUSTOMER });
    const res = await request(app).get('/api/contact').set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(403);
  });

  it('lists submitted enquiries newest first, with an unread count, and marks one read', async () => {
    const token = await adminToken();

    await request(app).post('/api/contact').send({ name: 'Thandi', email: 'thandi@example.com', message: 'First enquiry' });
    await request(app).post('/api/contact').send({ email: 'palesa@example.com', message: 'Second enquiry, no name' });

    const listRes = await request(app).get('/api/contact').set('Authorization', `Bearer ${token}`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.enquiries).toHaveLength(2);
    expect(listRes.body.unreadCount).toBe(2);
    expect(listRes.body.enquiries[0].message).toBe('Second enquiry, no name');
    expect(listRes.body.enquiries[1].name).toBe('Thandi');

    const id = listRes.body.enquiries[0]._id;
    const readRes = await request(app).patch(`/api/contact/${id}/read`).set('Authorization', `Bearer ${token}`);
    expect(readRes.status).toBe(200);
    expect(readRes.body.enquiry.isRead).toBe(true);

    const listAfter = await request(app).get('/api/contact').set('Authorization', `Bearer ${token}`);
    expect(listAfter.body.unreadCount).toBe(1);
  });

  it('returns a clean 404 for marking an unknown enquiry read', async () => {
    const token = await adminToken();
    const res = await request(app)
      .patch('/api/contact/64b7f3f3f3f3f3f3f3f3f3f3/read')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});
