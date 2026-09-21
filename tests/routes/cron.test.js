import request from 'supertest';
import { createApp } from '../../src/app.js';
import { setTestDb } from '../../src/config/db.js';
import { createFakeDb } from '../helpers/fakeDb.js';
import { env } from '../../src/config/env.js';

const app = createApp();

beforeEach(() => {
  setTestDb(createFakeDb());
});

describe('POST /api/cron/reminders', () => {
  it('rejects a request with no secret header', async () => {
    const res = await request(app).post('/api/cron/reminders');
    expect(res.status).toBe(401);
  });

  it('rejects a request with the wrong secret', async () => {
    const res = await request(app).post('/api/cron/reminders').set('X-Cron-Secret', 'not-the-real-secret');
    expect(res.status).toBe(401);
  });

  it('runs the reminders job with the correct secret', async () => {
    const res = await request(app).post('/api/cron/reminders').set('X-Cron-Secret', env.CRON_SECRET);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: 0 });
  });
});

describe('POST /api/cron/expire-unpaid-appointments', () => {
  it('rejects a request with no secret header', async () => {
    const res = await request(app).post('/api/cron/expire-unpaid-appointments');
    expect(res.status).toBe(401);
  });

  it('runs the expiry job with the correct secret', async () => {
    const res = await request(app).post('/api/cron/expire-unpaid-appointments').set('X-Cron-Secret', env.CRON_SECRET);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ expiredCount: 0 });
  });
});
