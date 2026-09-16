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

describe('subscription plan admin CRUD', () => {
  it('rejects a non-admin creating a plan', async () => {
    const { accessToken } = await createUserAndToken({ role: ROLES.CUSTOMER });
    const res = await request(app)
      .post('/api/subscriptions/plans')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ name: 'Plan', priceCents: 10000, creditsPerPeriod: 2 });
    expect(res.status).toBe(403);
  });

  it('creates a plan and lists it publicly', async () => {
    const { accessToken } = await createUserAndToken({ role: ROLES.ADMIN, permissions: [PERMISSIONS.MANAGE_SUBSCRIPTIONS] });
    const createRes = await request(app)
      .post('/api/subscriptions/plans')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ name: 'Monthly Glow', priceCents: 50000, creditsPerPeriod: 4 });
    expect(createRes.status).toBe(201);

    const listRes = await request(app).get('/api/subscriptions/plans');
    expect(listRes.status).toBe(200);
    expect(listRes.body.plans).toHaveLength(1);
  });

  it('blocks deleting a plan with an active subscriber', async () => {
    const { accessToken } = await createUserAndToken({ role: ROLES.ADMIN, permissions: [PERMISSIONS.MANAGE_SUBSCRIPTIONS] });
    const createRes = await request(app)
      .post('/api/subscriptions/plans')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ name: 'Monthly Glow', priceCents: 50000, creditsPerPeriod: 4 });
    const planId = createRes.body.plan._id;

    const { accessToken: customerToken } = await createUserAndToken({ role: ROLES.CUSTOMER });
    await request(app).post('/api/subscriptions/subscribe').set('Authorization', `Bearer ${customerToken}`).send({ planId });

    const deleteRes = await request(app).delete(`/api/subscriptions/plans/${planId}`).set('Authorization', `Bearer ${accessToken}`);
    expect(deleteRes.status).toBe(409);
  });
});

describe('GET /api/subscriptions/me', () => {
  it('requires authentication', async () => {
    const res = await request(app).get('/api/subscriptions/me');
    expect(res.status).toBe(401);
  });

  it('returns null before subscribing', async () => {
    const { accessToken } = await createUserAndToken({ role: ROLES.CUSTOMER });
    const res = await request(app).get('/api/subscriptions/me').set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.subscription).toBeNull();
  });
});
