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

describe('POST /api/discount-codes/validate', () => {
  it('is publicly usable (guests can apply a code)', async () => {
    const { accessToken } = await createUserAndToken({ role: ROLES.ADMIN, permissions: [PERMISSIONS.MANAGE_DISCOUNTS] });
    const createRes = await request(app)
      .post('/api/discount-codes')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ code: 'SAVE10', type: 'percentage', value: 10 });
    expect(createRes.status).toBe(201);

    const res = await request(app).post('/api/discount-codes/validate').send({ code: 'save10', amountCents: 10000 });
    expect(res.status).toBe(200);
    expect(res.body.discountValueCents).toBe(1000);
  });
});

describe('discount code admin CRUD', () => {
  it('rejects a non-admin', async () => {
    const { accessToken } = await createUserAndToken({ role: ROLES.CUSTOMER });
    const res = await request(app).get('/api/discount-codes').set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(403);
  });

  it('creates, lists and deactivates a code', async () => {
    const { accessToken } = await createUserAndToken({ role: ROLES.ADMIN, permissions: [PERMISSIONS.MANAGE_DISCOUNTS] });

    const createRes = await request(app)
      .post('/api/discount-codes')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ type: 'fixed', value: 5000, usageLimit: 10 });
    expect(createRes.status).toBe(201);
    const id = createRes.body.discountCode._id;

    const listRes = await request(app).get('/api/discount-codes').set('Authorization', `Bearer ${accessToken}`);
    expect(listRes.body.discountCodes).toHaveLength(1);

    const deactivateRes = await request(app)
      .patch(`/api/discount-codes/${id}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ isActive: false });
    expect(deactivateRes.status).toBe(204);

    const validateRes = await request(app)
      .post('/api/discount-codes/validate')
      .send({ code: createRes.body.discountCode.code, amountCents: 10000 });
    expect(validateRes.status).toBe(400);
  });
});
