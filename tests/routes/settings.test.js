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

  it('lets an admin update the home page hero slideshow without touching other fields', async () => {
    const { accessToken } = await createUserAndToken({
      role: ROLES.ADMIN,
      permissions: [PERMISSIONS.MANAGE_SETTINGS],
    });
    const items = [
      { url: 'https://example.com/hero-1.mp4', type: 'video' },
      { url: 'https://example.com/hero-2.mp4', type: 'video' },
      { url: 'https://example.com/hero-3.mp4', type: 'video' },
    ];
    const res = await request(app)
      .patch('/api/settings')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ heroMediaItems: items });
    expect(res.status).toBe(200);
    expect(res.body.settings.heroMediaItems).toEqual(items);
    expect(res.body.settings.businessName).toBe('NailsByMandisa');
  });

  it('rejects an invalid heroMediaItems entry type', async () => {
    const { accessToken } = await createUserAndToken({
      role: ROLES.ADMIN,
      permissions: [PERMISSIONS.MANAGE_SETTINGS],
    });
    const res = await request(app)
      .patch('/api/settings')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ heroMediaItems: [{ url: 'https://example.com/hero.gif', type: 'gif' }] });
    expect(res.status).toBe(400);
  });

  it('rejects an empty heroMediaItems array', async () => {
    const { accessToken } = await createUserAndToken({
      role: ROLES.ADMIN,
      permissions: [PERMISSIONS.MANAGE_SETTINGS],
    });
    const res = await request(app)
      .patch('/api/settings')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ heroMediaItems: [] });
    expect(res.status).toBe(400);
  });
});
