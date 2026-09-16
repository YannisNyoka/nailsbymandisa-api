import request from 'supertest';
import { createApp } from '../../src/app.js';
import { setTestDb } from '../../src/config/db.js';
import { createFakeDb } from '../helpers/fakeDb.js';
import { createUserAndToken } from '../helpers/testAuth.js';
import * as loyaltyService from '../../src/services/loyaltyService.js';
import { ROLES, PERMISSIONS } from '../../src/config/constants.js';

const app = createApp();

beforeEach(() => {
  setTestDb(createFakeDb());
});

describe('GET /api/loyalty/me', () => {
  it('requires authentication', async () => {
    const res = await request(app).get('/api/loyalty/me');
    expect(res.status).toBe(401);
  });

  it("returns the caller's own balance/tier/ledger", async () => {
    const { userId, accessToken } = await createUserAndToken({ role: ROLES.CUSTOMER });
    await loyaltyService.awardPoints({ userId, points: 250, source: 'booking_deposit_payment' });

    const res = await request(app).get('/api/loyalty/me').set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.pointsBalance).toBe(250);
    expect(res.body.tier.name).toEqual(expect.any(String));
  });
});

describe('POST /api/loyalty/clients/:userId/adjust', () => {
  it('rejects a non-admin', async () => {
    const { userId, accessToken } = await createUserAndToken({ role: ROLES.CUSTOMER });
    const res = await request(app)
      .post(`/api/loyalty/clients/${userId}/adjust`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ points: 100 });
    expect(res.status).toBe(403);
  });

  it('lets an admin with manage_loyalty award or deduct points', async () => {
    const { userId } = await createUserAndToken({ role: ROLES.CUSTOMER });
    const { accessToken: adminToken } = await createUserAndToken({
      role: ROLES.ADMIN,
      permissions: [PERMISSIONS.MANAGE_LOYALTY],
    });

    const awardRes = await request(app)
      .post(`/api/loyalty/clients/${userId}/adjust`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ points: 100, note: 'Goodwill' });
    expect(awardRes.status).toBe(200);
    expect(awardRes.body.pointsBalance).toBe(100);

    const deductRes = await request(app)
      .post(`/api/loyalty/clients/${userId}/adjust`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ points: -40 });
    expect(deductRes.status).toBe(200);
    expect(deductRes.body.pointsBalance).toBe(60);
  });
});
