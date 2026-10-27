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

describe('POST /api/cron/complete-past-appointments', () => {
  it('rejects a request with no secret header', async () => {
    const res = await request(app).post('/api/cron/complete-past-appointments');
    expect(res.status).toBe(401);
  });

  it('runs the completion job with the correct secret', async () => {
    const res = await request(app).post('/api/cron/complete-past-appointments').set('X-Cron-Secret', env.CRON_SECRET);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ completedCount: 0 });
  });
});

describe('POST /api/cron/reconcile-pending-payments', () => {
  it('rejects a request with no secret header', async () => {
    const res = await request(app).post('/api/cron/reconcile-pending-payments');
    expect(res.status).toBe(401);
  });

  // No pending_payment appointment exists in this fresh fake DB, so the sweep's own loop
  // never runs and never reaches out to the real Yoco API — same zero-result shape as the
  // other cron jobs above on an empty DB.
  it('runs the reconciliation sweep with the correct secret', async () => {
    const res = await request(app).post('/api/cron/reconcile-pending-payments').set('X-Cron-Secret', env.CRON_SECRET);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ scannedCount: 0, confirmedCount: 0 });
  });
});
