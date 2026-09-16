import request from 'supertest';
import { createApp } from '../../src/app.js';
import { setTestDb } from '../../src/config/db.js';
import { createFakeDb } from '../helpers/fakeDb.js';

const app = createApp();

beforeEach(() => {
  setTestDb(createFakeDb());
});

describe('GET /api/referrals/me', () => {
  it('requires authentication', async () => {
    const res = await request(app).get('/api/referrals/me');
    expect(res.status).toBe(401);
  });

  it('returns the referral code and tracks a completed referral', async () => {
    const referrerRes = await request(app).post('/api/auth/register').send({
      email: 'referrer@example.com',
      password: 'supersecret123',
      firstName: 'Ref',
      lastName: 'Errer',
    });
    const referrerCode = referrerRes.body.user.referralCode;

    await request(app).post('/api/auth/register').send({
      email: 'friend@example.com',
      password: 'supersecret123',
      firstName: 'Friend',
      lastName: 'Person',
      referralCode: referrerCode,
    });

    const res = await request(app)
      .get('/api/referrals/me')
      .set('Authorization', `Bearer ${referrerRes.body.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.referralCode).toBe(referrerCode);
    expect(res.body.referrals).toHaveLength(1);
    expect(res.body.referrals[0].status).toBe('pending');
  });
});
