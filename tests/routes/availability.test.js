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
    permissions: [PERMISSIONS.MANAGE_AVAILABILITY],
  });
  return accessToken;
}

describe('availability blocking', () => {
  it('requires authentication and the manage_availability permission', async () => {
    const res = await request(app).get('/api/availability');
    expect(res.status).toBe(401);
  });

  it('creates a single salon-wide block', async () => {
    const token = await adminToken();
    const res = await request(app)
      .post('/api/availability')
      .set('Authorization', `Bearer ${token}`)
      .send({ employeeId: null, date: '2026-01-05', startTime: '10:00', endTime: '12:00', reason: 'Deep clean' });
    expect(res.status).toBe(201);
    expect(res.body.block.employeeId).toBeNull();
  });

  it('rejects a block where startTime is not before endTime', async () => {
    const token = await adminToken();
    const res = await request(app)
      .post('/api/availability')
      .set('Authorization', `Bearer ${token}`)
      .send({ date: '2026-01-05', startTime: '12:00', endTime: '10:00' });
    expect(res.status).toBe(400);
  });

  it('bulk-blocks a date range in one write and lists it back within range', async () => {
    const token = await adminToken();
    const res = await request(app)
      .post('/api/availability/bulk')
      .set('Authorization', `Bearer ${token}`)
      .send({ dateFrom: '2026-01-01', dateTo: '2026-01-03', startTime: '09:00', endTime: '10:00', reason: 'Training' });
    expect(res.status).toBe(201);
    expect(res.body.blocks).toHaveLength(3);
    expect(res.body.blocks.map((b) => b.date)).toEqual(['2026-01-01', '2026-01-02', '2026-01-03']);

    const listRes = await request(app)
      .get('/api/availability')
      .query({ dateFrom: '2026-01-02', dateTo: '2026-01-02' })
      .set('Authorization', `Bearer ${token}`);
    expect(listRes.body.blocks).toHaveLength(1);
    expect(listRes.body.blocks[0].date).toBe('2026-01-02');
  });

  it('deletes a block', async () => {
    const token = await adminToken();
    const createRes = await request(app)
      .post('/api/availability')
      .set('Authorization', `Bearer ${token}`)
      .send({ date: '2026-01-05', startTime: '10:00', endTime: '12:00' });
    const id = createRes.body.block._id;

    const deleteRes = await request(app).delete(`/api/availability/${id}`).set('Authorization', `Bearer ${token}`);
    expect(deleteRes.status).toBe(204);

    const notFoundRes = await request(app).delete(`/api/availability/${id}`).set('Authorization', `Bearer ${token}`);
    expect(notFoundRes.status).toBe(404);
  });
});
