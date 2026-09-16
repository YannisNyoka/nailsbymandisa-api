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

describe('settings', () => {
  it('is publicly readable and seeds defaults on first read', async () => {
    const res = await request(app).get('/api/settings');
    expect(res.status).toBe(200);
    expect(res.body.settings.businessName).toBe('NailsByMandisa');
    expect(res.body.settings.bookingDepositCents).toEqual(expect.any(Number));
  });

  it('rejects an update from a customer', async () => {
    const { accessToken } = await createUserAndToken({ role: ROLES.CUSTOMER });
    const res = await request(app)
      .patch('/api/settings')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ businessName: 'Hacked' });
    expect(res.status).toBe(403);
  });

  it('lets an admin with manage_settings update the deposit amount', async () => {
    const { accessToken } = await createUserAndToken({
      role: ROLES.ADMIN,
      permissions: [PERMISSIONS.MANAGE_SETTINGS],
    });
    const res = await request(app)
      .patch('/api/settings')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ bookingDepositCents: 20000 });
    expect(res.status).toBe(200);
    expect(res.body.settings.bookingDepositCents).toBe(20000);
  });

  it('lets an admin update the home page hero media without touching other fields', async () => {
    const { accessToken } = await createUserAndToken({
      role: ROLES.ADMIN,
      permissions: [PERMISSIONS.MANAGE_SETTINGS],
    });
    const res = await request(app)
      .patch('/api/settings')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ heroMedia: { url: 'https://example.com/hero.mp4', type: 'video' } });
    expect(res.status).toBe(200);
    expect(res.body.settings.heroMedia).toEqual({ url: 'https://example.com/hero.mp4', type: 'video' });
    expect(res.body.settings.businessName).toBe('NailsByMandisa');
  });

  it('rejects an invalid heroMedia type', async () => {
    const { accessToken } = await createUserAndToken({
      role: ROLES.ADMIN,
      permissions: [PERMISSIONS.MANAGE_SETTINGS],
    });
    const res = await request(app)
      .patch('/api/settings')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ heroMedia: { url: 'https://example.com/hero.gif', type: 'gif' } });
    expect(res.status).toBe(400);
  });
});
