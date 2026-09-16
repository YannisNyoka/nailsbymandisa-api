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

const sampleService = {
  name: 'Gel manicure',
  category: 'gel',
  durationMinutes: 60,
  priceCents: 35000,
};

async function adminToken() {
  const { accessToken } = await createUserAndToken({
    role: ROLES.ADMIN,
    permissions: [PERMISSIONS.MANAGE_SERVICES],
  });
  return accessToken;
}

describe('services CRUD', () => {
  it('rejects creation without the manage_services permission', async () => {
    const { accessToken } = await createUserAndToken({ role: ROLES.CUSTOMER });
    const res = await request(app)
      .post('/api/services')
      .set('Authorization', `Bearer ${accessToken}`)
      .send(sampleService);
    expect(res.status).toBe(403);
  });

  it('rejects an invalid payload with 400', async () => {
    const token = await adminToken();
    const res = await request(app)
      .post('/api/services')
      .set('Authorization', `Bearer ${token}`)
      .send({ ...sampleService, category: 'not-a-real-category' });
    expect(res.status).toBe(400);
  });

  it('creates, lists, updates and soft-deletes a service', async () => {
    const token = await adminToken();

    const createRes = await request(app)
      .post('/api/services')
      .set('Authorization', `Bearer ${token}`)
      .send(sampleService);
    expect(createRes.status).toBe(201);
    const id = createRes.body.service._id;

    const publicListBefore = await request(app).get('/api/services');
    expect(publicListBefore.body.services).toHaveLength(1);

    const updateRes = await request(app)
      .patch(`/api/services/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ priceCents: 40000 });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.service.priceCents).toBe(40000);

    const deleteRes = await request(app).delete(`/api/services/${id}`).set('Authorization', `Bearer ${token}`);
    expect(deleteRes.status).toBe(204);

    // Soft-deleted (isActive: false) — no longer visible to the public list...
    const publicListAfter = await request(app).get('/api/services');
    expect(publicListAfter.body.services).toHaveLength(0);

    // ...but still visible to an admin.
    const adminListAfter = await request(app).get('/api/services').set('Authorization', `Bearer ${token}`);
    expect(adminListAfter.body.services).toHaveLength(1);
  });

  it('returns a clean 400 for a malformed id, not a 500', async () => {
    // Every :id route ultimately does `new ObjectId(req.params.id)` somewhere; a
    // malformed id must not surface as an unhandled 500 (§5.6/§5.11).
    const res = await request(app).get('/api/services/not-a-valid-id');
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Invalid id format.');
    expect(res.body.error.stack).toBeUndefined();
  });
});
