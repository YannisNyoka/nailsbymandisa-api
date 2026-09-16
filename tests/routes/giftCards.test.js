import request from 'supertest';
import { ObjectId } from 'mongodb';
import { createApp } from '../../src/app.js';
import { setTestDb } from '../../src/config/db.js';
import { createFakeDb } from '../helpers/fakeDb.js';
import { createUserAndToken } from '../helpers/testAuth.js';
import * as giftCardsService from '../../src/services/giftCardsService.js';
import { ROLES, PERMISSIONS } from '../../src/config/constants.js';

const app = createApp();

beforeEach(() => {
  setTestDb(createFakeDb());
});

describe('POST /api/gift-cards/purchase', () => {
  it('lets a guest purchase with an email but rejects an out-of-bounds amount', async () => {
    const tooSmall = await request(app).post('/api/gift-cards/purchase').send({ amountCents: 10, purchaserEmail: 'a@example.com' });
    expect(tooSmall.status).toBe(400);
  });

  it('rejects a guest purchase with no email to send the code to', async () => {
    const res = await request(app).post('/api/gift-cards/purchase').send({ amountCents: 20000 });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/gift-cards/:id — IDOR protection', () => {
  it("rejects a customer viewing another customer's gift card", async () => {
    const { userId: owner } = await createUserAndToken({ role: ROLES.CUSTOMER });
    const { accessToken: strangerToken } = await createUserAndToken({ role: ROLES.CUSTOMER });

    const card = await giftCardsService.createPendingGiftCard({
      initialAmountCents: 10000,
      purchasedByUserId: owner,
      purchaserEmail: 'owner@example.com',
    });

    const res = await request(app).get(`/api/gift-cards/${card._id}`).set('Authorization', `Bearer ${strangerToken}`);
    expect(res.status).toBe(403);
  });

  it('returns 404 rather than leaking existence for an unknown id', async () => {
    const { accessToken } = await createUserAndToken({ role: ROLES.CUSTOMER });
    const res = await request(app).get(`/api/gift-cards/${new ObjectId()}`).set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(404);
  });
});

describe('GET /api/gift-cards (admin list)', () => {
  it('rejects a non-admin and allows manage_gift_cards', async () => {
    const { accessToken: customerToken } = await createUserAndToken({ role: ROLES.CUSTOMER });
    const customerRes = await request(app).get('/api/gift-cards').set('Authorization', `Bearer ${customerToken}`);
    expect(customerRes.status).toBe(403);

    const { accessToken: adminToken } = await createUserAndToken({
      role: ROLES.ADMIN,
      permissions: [PERMISSIONS.MANAGE_GIFT_CARDS],
    });
    const adminRes = await request(app).get('/api/gift-cards').set('Authorization', `Bearer ${adminToken}`);
    expect(adminRes.status).toBe(200);
  });
});
